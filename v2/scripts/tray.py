#!/usr/bin/env python3
"""Optional GTK3 status icon for Jarvis.

GNOME 42 on Wayland does not show legacy XEmbed tray icons unless a status-icon
extension is enabled. The app remains usable without this script; it is a
convenience for desktops that still expose a tray.
"""
from __future__ import annotations

import os
import subprocess
import sys
import urllib.request

try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import GLib, Gtk
except Exception as error:  # pragma: no cover - depends on host GI
    print(f"tray unavailable: {error}", file=sys.stderr)
    raise SystemExit(1)

PORT = os.environ.get("JARVIS_PORT", "3081")
URL = os.environ.get("JARVIS_URL", f"http://127.0.0.1:{PORT}/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(ROOT, "web", "icons", "jarvis.svg")


def open_jarvis(_item=None) -> None:
    subprocess.Popen(["xdg-open", URL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def online() -> bool:
    try:
        with urllib.request.urlopen(f"{URL.rstrip('/')}/api/health", timeout=1.2) as response:
            return response.status == 200
    except Exception:
        return False


def main() -> int:
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        print("tray needs a graphical session", file=sys.stderr)
        return 1
    try:
        icon = Gtk.StatusIcon.new_from_file(ICON) if os.path.exists(ICON) else Gtk.StatusIcon.new_from_icon_name("dialog-information")
    except Exception:
        icon = Gtk.StatusIcon.new_from_icon_name("dialog-information")
    icon.set_title("Jarvis")
    icon.connect("activate", open_jarvis)

    menu = Gtk.Menu()
    open_item = Gtk.MenuItem(label="打开 Jarvis")
    open_item.connect("activate", open_jarvis)
    menu.append(open_item)
    menu.append(Gtk.SeparatorMenuItem())
    quit_item = Gtk.MenuItem(label="关闭托盘图标")
    quit_item.connect("activate", lambda _item: Gtk.main_quit())
    menu.append(quit_item)
    menu.show_all()

    def popup(_icon, button, activate_time):
        menu.popup(None, None, None, None, button, activate_time)

    icon.connect("popup-menu", popup)

    def poll():
        up = online()
        icon.set_tooltip_text("Jarvis · 在线" if up else "Jarvis · 离线（仍会尝试打开）")
        return True

    icon.set_tooltip_text("Jarvis · 检查中")
    icon.set_visible(True)
    GLib.timeout_add_seconds(10, poll)
    poll()
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
