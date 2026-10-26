# Starts Sydent as `python -m sydent.sydent` does, with one change. Server discovery falls
# back to port 8448 when the name has no SRV record, but Sydent 2.6.1 only does that for
# NXDOMAIN; some resolvers (a macOS VM's NAT DNS) answer SERVFAIL for `.localhost`, and
# then OpenID verification against the homeserver `localhost` fails. Here any DNS error
# for an SRV record counts as "no record".
from twisted.names.error import DomainError

from sydent.http import srvresolver
from sydent.sydent import main

_resolve_service = srvresolver.SrvResolver.resolve_service


async def _resolve_service_or_none(self, service_name):
    try:
        return await _resolve_service(self, service_name)
    except DomainError:
        return []


srvresolver.SrvResolver.resolve_service = _resolve_service_or_none

main()
