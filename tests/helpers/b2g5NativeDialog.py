"""Operate only a mapped, exact-title native consent window owned by the test PID."""
import ctypes as c,sys,time,subprocess
x=c.CDLL('libX11.so.6'); xt=c.CDLL('libXtst.so.6')
x.XOpenDisplay.restype=c.c_void_p; d=x.XOpenDisplay(None); assert d
x.XDefaultRootWindow.argtypes=[c.c_void_p]; x.XDefaultRootWindow.restype=c.c_ulong
x.XQueryTree.argtypes=[c.c_void_p,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.POINTER(c.c_ulong)),c.POINTER(c.c_uint)]
x.XFetchName.argtypes=[c.c_void_p,c.c_ulong,c.POINTER(c.c_char_p)]
x.XInternAtom.argtypes=[c.c_void_p,c.c_char_p,c.c_int]; x.XInternAtom.restype=c.c_ulong
x.XGetWindowProperty.argtypes=[c.c_void_p,c.c_ulong,c.c_ulong,c.c_long,c.c_long,c.c_int,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_int),c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.c_void_p)]
x.XFree.argtypes=[c.c_void_p]
x.XSetInputFocus.argtypes=[c.c_void_p,c.c_ulong,c.c_int,c.c_ulong]
x.XRaiseWindow.argtypes=[c.c_void_p,c.c_ulong]; x.XFlush.argtypes=[c.c_void_p]
x.XKeysymToKeycode.argtypes=[c.c_void_p,c.c_ulong]; x.XKeysymToKeycode.restype=c.c_uint
xt.XTestFakeKeyEvent.argtypes=[c.c_void_p,c.c_uint,c.c_int,c.c_ulong]
pid=int(sys.argv[1]); choice=sys.argv[2]
assert pid > 1 and choice in ('cancel', 'accept')
def walk(w):
 root=c.c_ulong(); parent=c.c_ulong(); children=c.POINTER(c.c_ulong)(); count=c.c_uint()
 if not x.XQueryTree(d,w,c.byref(root),c.byref(parent),c.byref(children),c.byref(count)): return
 ids=[children[i] for i in range(count.value)]; x.XFree(children)
 for child in ids:
  title=c.c_char_p(); x.XFetchName(d,child,c.byref(title)); name=title.value.decode(errors='replace') if title.value else ''; x.XFree(title)
  if name=='Enable Trusted Development?':
   typ=c.c_ulong(); fmt=c.c_int(); n=c.c_ulong(); rest=c.c_ulong(); data=c.c_void_p()
   x.XGetWindowProperty(d,child,x.XInternAtom(d,b'_NET_WM_PID',0),0,1,0,6,c.byref(typ),c.byref(fmt),c.byref(n),c.byref(rest),c.byref(data))
   owner=c.cast(data,c.POINTER(c.c_ulong))[0] if data.value and n.value else 0
   if data.value: x.XFree(data)
   if owner==pid and 'Map State: IsViewable' in subprocess.check_output(['/usr/bin/xwininfo','-id',str(child)],text=True): return child
  found=walk(child)
  if found:return found
for _ in range(150):
 w=walk(x.XDefaultRootWindow(d))
 if w:break
 time.sleep(.1)
else:raise RuntimeError('Owned native confirmation not found')
x.XRaiseWindow(d,w); x.XSetInputFocus(d,w,2,0); x.XFlush(d);time.sleep(.2)
# Native default/cancel is Keep Isolated. Escape cancels; Tab moves to Enable.
keys=[0xff1b] if choice=='cancel' else [0xff09,0xff0d]
for symbol in keys:
 key=x.XKeysymToKeycode(d,symbol);xt.XTestFakeKeyEvent(d,key,1,0);xt.XTestFakeKeyEvent(d,key,0,0);x.XFlush(d);time.sleep(.15)
print('operated owned native confirmation:',choice)
