"""Make the key pair the server signs push notifications with (VAPID), once, for .env.

    python tools/make_vapid_keys.py

Prints two lines to put in .env (the server's) or dev.env. The push services (Google's, Apple's,
Mozilla's) only deliver a push to a subscription if it's signed with the private key belonging to
the public key the browser subscribed with: so nobody else can send our users notifications.

Keep the private key secret, like the other secrets in .env. A new key pair later works too, but
then every phone has to turn its notifications off and on again (their subscriptions belong to
the old public key).
"""
import base64
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def b64url(data):
    """Base64 for URLs (- and _ instead of + and /, no = at the end): how Web Push writes keys."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


# An elliptic curve key pair on the P-256 curve, the one Web Push uses.
private_key = ec.generate_private_key(ec.SECP256R1())
private_number = private_key.private_numbers().private_value.to_bytes(32, "big")  # the 32 secret bytes
public_point = private_key.public_key().public_bytes(  # the public key as the browser wants it
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
)
print(f"VAPID_PUBLIC_KEY={b64url(public_point)}")
print(f"VAPID_PRIVATE_KEY={b64url(private_number)}")
