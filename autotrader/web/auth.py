import base64
import binascii
import secrets


def is_authorized(authorization_header: str | None, username: str, password: str) -> bool:
    """Checks an incoming `Authorization` header against a single expected
    HTTP Basic Auth username/password, using a constant-time comparison so
    response timing can't leak how many characters of the password matched."""
    if not authorization_header or not authorization_header.startswith("Basic "):
        return False
    encoded = authorization_header[len("Basic ") :]
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return False
    if ":" not in decoded:
        return False
    given_username, given_password = decoded.split(":", 1)
    username_ok = secrets.compare_digest(given_username, username)
    password_ok = secrets.compare_digest(given_password, password)
    return username_ok and password_ok
