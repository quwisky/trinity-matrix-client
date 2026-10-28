# Starts Sydent as `python -m sydent.sydent` does, with two changes. Server discovery falls
# back to port 8448 when the name has no SRV record, but Sydent 2.6.1 only does that for
# NXDOMAIN; some resolvers (a macOS VM's NAT DNS) answer SERVFAIL for `.localhost`, and
# then OpenID verification against the homeserver `localhost` fails. Here any DNS error
# for an SRV record counts as "no record". And TRINITY_E2E_FEDERATION_PORT, set by the
# native runtime, replaces that 8448 so an offset stack reaches its own homeserver.
import os

from twisted.names.error import DomainError

from sydent.http import srvresolver
from sydent.sydent import main

_resolve_service = srvresolver.SrvResolver.resolve_service


_federation_port = int(os.environ.get("TRINITY_E2E_FEDERATION_PORT") or 0)


async def _resolve_service_or_none(self, service_name):
    try:
        servers = await _resolve_service(self, service_name)
    except DomainError:
        servers = []
    if servers or not _federation_port:
        return servers
    # `_matrix-fed._tcp.<host>` -> <host>
    host = service_name.split(b".", 2)[2]
    return [srvresolver.Server(host=host, port=_federation_port)]


srvresolver.SrvResolver.resolve_service = _resolve_service_or_none

main()
