# Security policy

## Supported versions

Security fixes are provided for the latest tagged release.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving authentication bypass, room-token disclosure, arbitrary file access, command execution, updater signing, or TURN credential exposure.

Use GitHub private vulnerability reporting for `BicLex-Games/hub`, or contact the maintainers through the private contact listed at [biclex.ru](https://biclex.ru/). Include affected versions, reproduction steps, impact, and any suggested mitigation.

## Deployment notes

- Treat a connection code and `ROOM_TOKEN` as credentials.
- Use HTTPS/WSS through a trusted reverse proxy for Internet-facing signaling.
- Use unique random TURN and room secrets per deployment.
- Restrict SSH, Docker, and registry write access to administrators.
- Back up the persistent `data` directory.
- BicLex Hub media is encrypted in transit with WebRTC DTLS-SRTP, but the SFU architecture is not end-to-end encrypted between participants.
