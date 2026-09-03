#!/usr/bin/env python3
"""
Hold a GNOME Shell screencast open for as long as this process lives.

GNOME ties the recording to the *caller's D-Bus connection*: the moment the
client that invoked Screencast disconnects, the shell stops recording and posts
"Screencast ended unexpectedly". A one-shot `busctl call` therefore records only
the second or two before it exits, which looks like a working command and
produces a truncated file.

So this process makes the call and then simply stays alive on a GLib main loop.
Send it SIGINT or SIGTERM to stop cleanly; it calls StopScreencast on the same
connection before exiting, which is what flushes the WebM trailer. Killing it
with SIGKILL leaves an unplayable file.

Usage: screencast.py OUTPUT.webm [framerate]
"""

import signal
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

BUS_NAME = "org.gnome.Shell.Screencast"
OBJ_PATH = "/org/gnome/Shell/Screencast"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: screencast.py OUTPUT.webm [framerate] [x y w h]", file=sys.stderr)
        return 2

    out = sys.argv[1]
    framerate = int(sys.argv[2]) if len(sys.argv) > 2 else 30

    # An area is not a nicety. GNOME Shell posts "Screencast ended unexpectedly"
    # as an internal MessageTray notification — not through the freedesktop
    # Notifications API — so CloseNotification cannot dismiss it and it lands in
    # the middle of the top edge of every recording. Cropping the strip it lives
    # in is the only reliable way to keep it out, and it removes the clock and the
    # browser tab bar too, which a demo is better without.
    area = [int(v) for v in sys.argv[3:7]] if len(sys.argv) >= 7 else None

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    proxy = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.NONE, None, BUS_NAME, OBJ_PATH, BUS_NAME, None
    )

    # draw-cursor matters for a demo: without it the pointer is invisible and
    # clicks look like they happen by themselves.
    #
    # The dict stays a plain dict: PyGObject builds the a{sv} itself and only the
    # *values* need wrapping. Passing an already-built Variant here raises.
    options = {
        "framerate": GLib.Variant("i", framerate),
        "draw-cursor": GLib.Variant("b", True),
    }

    ok, filename = (
        proxy.call_sync(
            "ScreencastArea",
            GLib.Variant("(iiiisa{sv})", (*area, out, options)),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
        if area
        else proxy.call_sync(
            "Screencast",
            GLib.Variant("(sa{sv})", (out, options)),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
    ).unpack()

    if not ok:
        print(f"screencast refused by the shell (requested {out})", file=sys.stderr)
        return 1

    print(f"RECORDING {filename}", flush=True)

    loop = GLib.MainLoop()

    def stop(*_args: object) -> bool:
        try:
            proxy.call_sync(
                "StopScreencast", None, Gio.DBusCallFlags.NONE, -1, None
            )
        except GLib.Error as err:  # already stopped, or the shell restarted
            print(f"stop failed: {err.message}", file=sys.stderr)
        loop.quit()
        return False

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, stop)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, stop)
    loop.run()

    print(f"STOPPED {filename}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
