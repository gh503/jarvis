#!/usr/bin/env python3
"""Single-shot screenshot through the XDG desktop portal.

The portal owns the permission UI. We deliberately do not read the Wayland
framebuffer directly: on GNOME/Wayland that is both brittle and a privacy
violation. If the user denies the request, this exits non-zero and Jarvis tells
them why.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import urllib.parse

try:
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except Exception as exc:  # pragma: no cover - depends on host packages
    print(f"portal helper unavailable: {exc}", file=sys.stderr)
    raise SystemExit(3)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    result: dict[str, object] = {"done": False, "code": 1, "uri": None}

    def on_response(_conn, _sender, _path, _iface, _signal, params, _data):
        response, options = params.unpack()
        result["done"] = True
        result["code"] = int(response)
        if response == 0:
            result["uri"] = options.get("uri")
        loop.quit()

    subscription = bus.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        None,
        None,
        Gio.DBusSignalFlags.NONE,
        on_response,
        None,
    )
    if subscription is None:
        print("could not subscribe to portal response", file=sys.stderr)
        return 3

    def on_timeout():
        result["code"] = 4
        loop.quit()
        return GLib.SOURCE_REMOVE

    GLib.timeout_add_seconds(max(1, args.timeout), on_timeout)

    try:
        reply = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Screenshot",
            "Screenshot",
            GLib.Variant(
                "(sa{sv})",
                (
                    "",
                    {
                        "interactive": GLib.Variant("b", False),
                        "modal": GLib.Variant("b", False),
                    },
                ),
            ),
            GLib.VariantType.new("(o)"),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
        _handle = reply.unpack()[0]
    except Exception as exc:
        print(f"portal screenshot request failed: {exc}", file=sys.stderr)
        return 3

    loop.run()
    bus.signal_unsubscribe(subscription)

    if not result["done"]:
        print("portal screenshot timed out", file=sys.stderr)
        return 4
    if result["code"] != 0:
        print(f"portal screenshot denied or failed (response={result['code']})", file=sys.stderr)
        return 2
    uri = result.get("uri")
    if not isinstance(uri, str):
        print("portal returned no uri", file=sys.stderr)
        return 5

    parsed = urllib.parse.urlparse(uri)
    source = urllib.parse.unquote(parsed.path)
    if parsed.scheme != "file" or not os.path.isfile(source):
        print(f"portal returned unsupported uri: {uri}", file=sys.stderr)
        return 5

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    shutil.copyfile(source, args.output)
    os.chmod(args.output, 0o600)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())