//! The delivery barrier: a command that changed what a subscriber stream shows waits until the
//! carrier has written that change, so its effect reaches the output before its reply.
//!
//! The carrier polls a stream again only after it has emitted the previous item, and drops it
//! after its `complete`. So a [`Tracked`] stream counts an item as delivered on the next poll,
//! and its close as delivered when it is dropped. Wrap it only in adapters that poll it once per
//! item they yield and keep it until they complete, such as `map`: one that buffers counts items
//! before they are emitted, and one that drops it early, such as `chain`, meets a close ticket
//! before the carrier emits the `complete`.

use std::{
    collections::HashMap,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use futures_util::Stream;
use matrix_sdk::timeout::timeout;
use tokio::sync::{mpsc, watch};

pub const DELIVERY_LIMIT: Duration = Duration::from_secs(5);

/// Subscriber streams of one kind of update, by key.
#[derive(Debug)]
pub struct Subscribers<T> {
    next_key: u64,
    entries: HashMap<u64, Entry<T>>,
}

#[derive(Debug)]
struct Entry<T> {
    tx: mpsc::UnboundedSender<T>,
    sent: u64,
    delivered: watch::Receiver<u64>,
}

impl<T> Default for Subscribers<T> {
    fn default() -> Self {
        Self {
            next_key: 0,
            entries: HashMap::new(),
        }
    }
}

impl<T: Clone> Subscribers<T> {
    /// A new subscriber stream, which starts with `first` when there is one.
    pub fn subscribe(&mut self, first: Option<T>) -> (u64, Tracked<T>) {
        self.entries.retain(|_, entry| !entry.tx.is_closed());
        let (tx, rx) = mpsc::unbounded_channel();
        let (delivered_tx, delivered) = watch::channel(0);
        let mut entry = Entry {
            tx,
            sent: 0,
            delivered,
        };
        if let Some(first) = first {
            let _ = entry.send(first);
        }
        let key = self.next_key;
        self.next_key += 1;
        self.entries.insert(key, entry);
        let stream = Tracked {
            rx,
            taken: 0,
            delivered: delivered_tx,
        };
        (key, stream)
    }

    /// Sends `item` to every subscriber, forgetting those whose stream is gone.
    pub fn publish(&mut self, item: &T) -> Barrier {
        self.entries.retain(|_, entry| !entry.tx.is_closed());
        let entries = self.entries.values_mut();
        Barrier(
            entries
                .filter_map(|entry| entry.send(item.clone()))
                .collect(),
        )
    }

    pub fn send_to(&mut self, key: u64, item: &T) -> Barrier {
        let ticket = self
            .entries
            .get_mut(&key)
            .and_then(|e| e.send(item.clone()));
        Barrier(ticket.into_iter().collect())
    }

    /// Completes the subscriber's stream once it has emitted what it was sent.
    pub fn close(&mut self, key: u64) -> Barrier {
        let entry = self.entries.remove(&key);
        Barrier(entry.into_iter().map(Entry::closed).collect())
    }

    pub fn close_all(&mut self) -> Barrier {
        Barrier(
            self.entries
                .drain()
                .map(|(_, entry)| entry.closed())
                .collect(),
        )
    }
}

impl<T> Entry<T> {
    /// The ticket for `item`, or `None` when the stream is gone.
    fn send(&mut self, item: T) -> Option<(watch::Receiver<u64>, u64)> {
        self.tx.send(item).ok()?;
        self.sent += 1;
        Some((self.delivered.clone(), self.sent))
    }

    /// Drops the sender, so the stream completes; only dropping the stream meets the ticket.
    fn closed(self) -> (watch::Receiver<u64>, u64) {
        (self.delivered, u64::MAX)
    }
}

/// A subscriber's stream, which reports how many of its items the carrier has emitted.
#[derive(Debug)]
pub struct Tracked<T> {
    rx: mpsc::UnboundedReceiver<T>,
    taken: u64,
    delivered: watch::Sender<u64>,
}

impl<T> Stream for Tracked<T> {
    type Item = T;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<T>> {
        // Polled again, so everything returned before is on the output.
        let taken = self.taken;
        self.delivered.send_replace(taken);
        let polled = self.rx.poll_recv(cx);
        if matches!(polled, Poll::Ready(Some(_))) {
            self.taken += 1;
        }
        polled
    }
}

/// What a command waits for before its reply: each ticket is a stream and the count of its items
/// that must be emitted first, or `u64::MAX` for its close.
#[must_use]
#[derive(Clone, Debug, Default)]
pub struct Barrier(Vec<(watch::Receiver<u64>, u64)>);

impl Barrier {
    pub fn join(mut self, other: Barrier) -> Barrier {
        self.0.extend(other.0);
        self
    }

    /// Waits until each ticket is delivered or its stream is gone; logs and gives up after
    /// [`DELIVERY_LIMIT`].
    pub async fn delivered(self) {
        let wait = async {
            for (mut delivered, target) in self.0 {
                // An error means the stream is gone, which delivers nothing more.
                let _ = delivered.wait_for(|taken| *taken >= target).await;
            }
        };
        if timeout(wait, DELIVERY_LIMIT).await.is_err() {
            tracing::warn!("delivery barrier timed out");
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::{FutureExt, StreamExt};

    use super::*;

    /// Whether `barrier` has been met, without waiting for it.
    fn met(barrier: &mut Pin<Box<impl Future<Output = ()>>>) -> bool {
        barrier.as_mut().now_or_never().is_some()
    }

    /// One poll of `stream`, as the carrier makes after emitting its previous item.
    fn poll<T>(stream: &mut Tracked<T>) -> Option<Option<T>> {
        stream.next().now_or_never()
    }

    #[tokio::test]
    async fn a_published_item_is_delivered_once_the_stream_is_polled_again() {
        let mut subscribers = Subscribers::default();
        let (_, mut stream) = subscribers.subscribe(None);
        let mut barrier = Box::pin(subscribers.publish(&1).delivered());
        assert!(!met(&mut barrier));
        assert_eq!(poll(&mut stream), Some(Some(1)));
        assert!(!met(&mut barrier), "taken is not yet emitted");
        assert_eq!(poll(&mut stream), None);
        assert!(met(&mut barrier));
    }

    #[tokio::test]
    async fn a_subscriber_not_yet_polled_must_emit_its_first_item_and_then_the_published_one() {
        let mut subscribers = Subscribers::default();
        let (_, mut stream) = subscribers.subscribe(Some(0));
        let mut barrier = Box::pin(subscribers.publish(&1).delivered());
        assert_eq!(poll(&mut stream), Some(Some(0)));
        assert_eq!(poll(&mut stream), Some(Some(1)));
        assert!(!met(&mut barrier));
        assert_eq!(poll(&mut stream), None);
        assert!(met(&mut barrier));
    }

    #[tokio::test]
    async fn a_close_is_delivered_when_the_stream_is_dropped() {
        let mut subscribers = Subscribers::default();
        let (key, mut stream) = subscribers.subscribe(Some(0));
        let mut barrier = Box::pin(subscribers.close(key).delivered());
        assert_eq!(poll(&mut stream), Some(Some(0)));
        assert_eq!(poll(&mut stream), Some(None), "the stream completes");
        assert!(!met(&mut barrier), "the complete is not yet emitted");
        drop(stream);
        assert!(met(&mut barrier));
    }

    #[tokio::test]
    async fn close_all_and_send_to_reach_only_their_subscribers() {
        let mut subscribers = Subscribers::default();
        let (one, mut first) = subscribers.subscribe(None);
        let (_, mut second) = subscribers.subscribe(None);
        let mut sent = Box::pin(subscribers.send_to(one, &7).delivered());
        assert_eq!(poll(&mut second), None);
        assert_eq!(poll(&mut first), Some(Some(7)));
        assert_eq!(poll(&mut first), None);
        assert!(met(&mut sent));
        let mut closed = Box::pin(subscribers.close_all().delivered());
        assert_eq!(poll(&mut first), Some(None));
        assert_eq!(poll(&mut second), Some(None));
        drop(first);
        assert!(!met(&mut closed), "the second complete is not yet emitted");
        drop(second);
        assert!(met(&mut closed));
    }

    #[tokio::test]
    async fn a_barrier_over_a_dropped_subscriber_resolves_at_once() {
        let mut subscribers = Subscribers::default();
        let (_, stream) = subscribers.subscribe(Some(0));
        let mut barrier = Box::pin(subscribers.publish(&1).delivered());
        drop(stream);
        assert!(met(&mut barrier));
        let mut after = Box::pin(subscribers.publish(&2).delivered());
        assert!(met(&mut after));
    }

    #[test]
    fn publish_prunes_closed_subscribers() {
        let mut subscribers = Subscribers::default();
        let (_, gone) = subscribers.subscribe(None);
        let (_, _kept) = subscribers.subscribe(None);
        drop(gone);
        let _ = subscribers.publish(&1);
        assert_eq!(subscribers.entries.len(), 1);
    }

    #[tokio::test]
    async fn a_joined_barrier_waits_for_every_ticket() {
        let mut subscribers = Subscribers::default();
        let (one, mut first) = subscribers.subscribe(None);
        let (two, mut second) = subscribers.subscribe(None);
        let barrier = subscribers
            .send_to(one, &1)
            .join(subscribers.send_to(two, &2));
        let mut barrier = Box::pin(barrier.delivered());
        assert_eq!(poll(&mut first), Some(Some(1)));
        assert_eq!(poll(&mut first), None);
        assert!(!met(&mut barrier));
        assert_eq!(poll(&mut second), Some(Some(2)));
        assert_eq!(poll(&mut second), None);
        assert!(met(&mut barrier));
    }

    #[tokio::test(start_paused = true)]
    async fn an_undelivered_barrier_gives_up_after_the_limit() {
        let mut subscribers = Subscribers::default();
        let (_, _never_polled) = subscribers.subscribe(None);
        let mut barrier = Box::pin(subscribers.publish(&1).delivered());
        let early = DELIVERY_LIMIT - Duration::from_millis(1);
        assert!(
            timeout(barrier.as_mut(), early).await.is_err(),
            "still waiting"
        );
        barrier.await;
    }

    #[test]
    fn subscribe_prunes_closed_subscribers() {
        let mut subscribers = Subscribers::<u8>::default();
        let (_, gone) = subscribers.subscribe(None);
        drop(gone);
        let (_, _kept) = subscribers.subscribe(None);
        assert_eq!(subscribers.entries.len(), 1);
    }
}
