"""macOS 防空闲休眠 wakelock。

后台分析/堆叠任务运行期间,用 `caffeinate -i` 阻止系统因空闲(屏保/锁屏)
而进入睡眠,从而保证 AI 线程不被冻结。引用计数实现,允许多个任务并发持有,
最后一个释放时才关闭 caffeinate,系统恢复正常休眠策略。

非 darwin 平台或 caffeinate 不可用时降级为 no-op。
"""
from __future__ import annotations

import atexit
import os
import subprocess
import sys
import threading


_lock = threading.Lock()
_count = 0
_proc: subprocess.Popen | None = None


def _spawn() -> subprocess.Popen | None:
    if sys.platform != "darwin":
        return None
    try:
        # -i 阻止空闲睡眠;-w <pid> 让 caffeinate 在本进程退出时自动结束,
        # 避免遗留 caffeinate 进程把机器永远撑醒。
        return subprocess.Popen(
            ["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None


def acquire() -> None:
    global _count, _proc
    with _lock:
        _count += 1
        if _count == 1 and (_proc is None or _proc.poll() is not None):
            _proc = _spawn()


def release() -> None:
    global _count, _proc
    with _lock:
        if _count <= 0:
            return
        _count -= 1
        if _count == 0 and _proc is not None and _proc.poll() is None:
            try:
                _proc.terminate()
            except Exception:
                pass
            _proc = None


class WakeLock:
    """`with WakeLock(): ...` 在 with 块内阻止系统空闲休眠。"""

    def __enter__(self) -> "WakeLock":
        acquire()
        return self

    def __exit__(self, *exc) -> None:
        release()


@atexit.register
def _cleanup() -> None:
    global _proc
    if _proc is not None and _proc.poll() is None:
        try:
            _proc.terminate()
        except Exception:
            pass
