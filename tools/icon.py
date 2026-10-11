from PIL import Image, ImageDraw, ImageFilter
import math, random
def make(S, maskable=False):
    K=4; W=S*K
    im=Image.new('RGBA',(W,W),(0,0,0,0))
    bg=Image.new('RGBA',(W,W))
    px=bg.load()
    for y in range(0,W):
        for x in range(0,W,1):
            pass
    # radial-ish gradient terracotta -> plum
    g=Image.linear_gradient('L').resize((W*2,W*2)).rotate(-35).crop((W//2,W//2,W//2+W,W//2+W))
    a=Image.new('RGBA',(W,W),(201,96,61,255)); b=Image.new('RGBA',(W,W),(58,34,44,255))
    bg=Image.composite(b,a,g)
    mask=Image.new('L',(W,W),0)
    d=ImageDraw.Draw(mask)
    if maskable: d.rectangle([0,0,W,W],fill=255)
    else: d.rounded_rectangle([W*0.04,W*0.04,W*0.96,W*0.96],radius=W*0.22,fill=255)
    im.paste(bg,(0,0),mask)
    # paper grain
    random.seed(3)
    stroke=Image.new('L',(W,W),0); sd=ImageDraw.Draw(stroke)
    sc=0.78 if maskable else 1.0
    cx,cy=W/2,W/2
    N=500
    for i in range(N):
        t=i/(N-1)
        ang=math.radians(215 - t*275)
        r=W*0.27*sc
        x=cx+math.cos(ang)*r; y=cy+math.sin(ang)*r*0.95
        if False:  # hook into a G bar
            u=(t-0.82)/0.18
            x=cx+math.cos(math.radians(200-0.82*290))*r - u*W*0.17*sc
            y=cy+math.sin(math.radians(200-0.82*290))*r*0.95
        w=W*0.075*sc*math.sin(math.pi*min(1,t*1.15))**0.6+W*0.006
        for k in range(3):
            jx=random.uniform(-1,1)*w*0.12; jy=random.uniform(-1,1)*w*0.12
            sd.ellipse([x-w+jx,y-w+jy,x+w+jx,y+w+jy],fill=255)
    # dry-brush streaks: knock out thin lines
    st=ImageDraw.Draw(stroke)
    for i in range(40):
        ang0=random.uniform(0,360); rr=W*0.27*sc+random.uniform(-1,1)*W*0.06*sc
        pts=[(cx+math.cos(math.radians(ang0+j))*rr, cy+math.sin(math.radians(ang0+j))*rr*0.95) for j in range(0,random.randint(10,50),3)]
        if len(pts)>1: st.line(pts,fill=0,width=max(1,int(W*0.004)))
    stroke=stroke.filter(ImageFilter.GaussianBlur(K*0.7))
    cream=Image.new('RGBA',(W,W),(246,238,224,255))
    im.paste(cream,(0,0),Image.composite(stroke,Image.new('L',(W,W),0),mask))
    # ochre dot
    dd=ImageDraw.Draw(im); R=W*0.055*sc
    dx,dy=cx+W*0.25*sc,cy-W*0.26*sc
    dd.ellipse([dx-R,dy-R,dx+R,dy+R],fill=(240,180,80,255))
    return im.resize((S,S),Image.LANCZOS)
import sys
o=sys.argv[1]
make(192).save(o+'/icon-192.png'); make(512).save(o+'/icon-512.png'); make(512,True).save(o+'/maskable-512.png')
