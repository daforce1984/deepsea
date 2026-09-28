"""Tiny TCP relay so WSL can reach a Windows-bound CDP debug port.

Chrome binds its --remote-debugging-port to 127.0.0.1 on Windows even with
--remote-debugging-address=0.0.0.0, and WSL2 (NAT mode) cannot reach the
Windows loopback. This relay listens on 0.0.0.0:<listen> on the Windows side
and forwards to 127.0.0.1:<target>, so WSL can connect via the gateway IP.

Run on WINDOWS python:  python cdp_relay.py <listen_port> <target_port>
"""
import socket, threading, sys

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9002
TARGET_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9001
LISTEN_HOST, TARGET_HOST = "0.0.0.0", "127.0.0.1"


def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except Exception:
        pass
    finally:
        try: a.shutdown(socket.SHUT_RD)
        except Exception: pass
        try: b.shutdown(socket.SHUT_WR)
        except Exception: pass


def handle(client):
    try:
        upstream = socket.create_connection((TARGET_HOST, TARGET_PORT))
    except Exception as e:
        print("upstream connect failed:", e, flush=True)
        client.close()
        return
    t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
    t1.start(); t2.start()
    t1.join(); t2.join()
    client.close(); upstream.close()


s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((LISTEN_HOST, LISTEN_PORT))
s.listen(64)
print(f"forwarding {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
