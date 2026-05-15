#!/usr/bin/env bash
# 在 Chrome 里打开 tailorbird,并把那个窗口拉到屏幕可用区域(避开菜单栏和 Dock)。
# 如果 Chrome 里已经有同 URL 的 tab,就复用,只切前台 + 重新最大化。
URL="${1:-http://127.0.0.1:7891}"

# 拿主屏的 visibleFrame(已扣掉菜单栏和 Dock),转成 AppleScript 的 {l, t, r, b} 坐标。
read -r L T R B < <(osascript -l JavaScript <<'JXA'
ObjC.import('AppKit')
var screen = $.NSScreen.mainScreen
var vf = screen.visibleFrame
var sfh = +screen.frame.size.height
var vfx = +vf.origin.x
var vfy = +vf.origin.y
var vfw = +vf.size.width
var vfh = +vf.size.height
var l = Math.round(vfx)
var top = Math.round(sfh - (vfy + vfh))
var r = Math.round(l + vfw)
var b = Math.round(top + vfh)
l + " " + top + " " + r + " " + b
JXA
)

osascript <<EOF
set targetURL to "$URL"
set screenBounds to {$L, $T, $R, $B}

tell application "Google Chrome"
  activate
  set foundWindow to missing value
  if (count of windows) is 0 then
    set foundWindow to make new window
    set URL of active tab of foundWindow to targetURL
  else
    repeat with w in windows
      set i to 1
      repeat with t in tabs of w
        if URL of t starts with targetURL then
          set foundWindow to w
          set active tab index of w to i
          exit repeat
        end if
        set i to i + 1
      end repeat
      if foundWindow is not missing value then exit repeat
    end repeat
    if foundWindow is missing value then
      set foundWindow to make new window
      set URL of active tab of foundWindow to targetURL
    end if
  end if
  set index of foundWindow to 1
  set bounds of foundWindow to screenBounds
end tell
EOF
