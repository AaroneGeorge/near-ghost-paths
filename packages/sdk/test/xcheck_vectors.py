# Independent re-derivation of docs/SPEC.md §8 vectors with pyca/cryptography (no noble, no SDK code).
# Run: python3 -I packages/sdk/test/xcheck_vectors.py
import json, hashlib, sys
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import x25519, ec, utils
V = json.load(open(sys.argv[1] if len(sys.argv) > 1 else __file__.rsplit("/", 1)[0] + "/vectors.json"))
n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
def kdf(ikm, info): return HKDF(hashes.SHA256(), 32, b"ghost-paths/v1", info).derive(ikm)
seed = bytes.fromhex(V["seed"])
d = int.from_bytes(kdf(seed, b"spend"), "big") % n
assert d == int(V["d_spend"], 16), "d_spend"
sp = ec.derive_private_key(d, ec.SECP256K1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint)
assert sp.hex() == V["spend_pub"], "spend_pub"
kv = kdf(seed, b"view"); assert kv.hex() == V["view_priv"]
vpub = x25519.X25519PrivateKey.from_private_bytes(kv).public_key().public_bytes_raw(); assert vpub.hex() == V["view_pub"], "view_pub"
e = x25519.X25519PrivateKey.from_private_bytes(bytes.fromhex("33"*32))
E = e.public_key().public_bytes_raw()
S = e.exchange(x25519.X25519PublicKey.from_public_bytes(vpub))
# recipient side
S2 = x25519.X25519PrivateKey.from_private_bytes(kv).exchange(x25519.X25519PublicKey.from_public_bytes(E)); assert S == S2
for chain in ["evm:31337", "sol:local", "btc:testnet4"]:
    t = V[chain]
    assert E.hex() == t["E"] and S.hex() == t["S"], "E/S"
    assert hashlib.sha256(b"ghost-paths/v1/view-tag" + S).digest()[0] == t["tag"], "tag"
    h = int.from_bytes(kdf(S, b"tweak" + E + sp + chain.encode()), "big") % n
    assert h == int(t["h"], 16), "h " + chain
    dK = (d + h) % n; assert dK == int(t["d_K"], 16)
    K = ec.derive_private_key(dK, ec.SECP256K1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    assert K.hex() == t["K"], "K " + chain   # K = (d+h)G == P_spend + hG
    assert t["path"] == "gp1/" + hashlib.sha256(K[1:]).hexdigest(), "path"
sw = V["sweep"]; t = V["evm:31337"]
cid = b"v1.ghost-paths.testnet"; path = t["path"].encode(); pl = bytes.fromhex("55"*32)
pre = b"ghost-paths/v1/sweep" + cid + path + bytes([0]) + (123456789).to_bytes(8, "big") + bytes([1]) + len(pl).to_bytes(2, "big") + pl
assert pre.hex() == sw["preimage"], "preimage"
msg = hashlib.sha256(pre).digest(); assert msg.hex() == sw["msg"]
r = int(sw["sig"][:64], 16); s = int(sw["sig"][64:], 16); assert s <= n // 2, "low-s"
pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), bytes.fromhex("04" + sw["k_pub"]))
pub.verify(utils.encode_dss_signature(r, s), msg, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
print("python cross-check OK: keys, ECDH, tag, tweak, K, path, d_K, sweep preimage/msg, signature")
