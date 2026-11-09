'use strict';
const clamp = (n, low, high) => Math.max(low, Math.min(Math.max(low, high), n));
function anchorFor(displays, saved, size) {
    const display = displays.find(d => String(d.id) === String(saved?.displayId)) || displays.find(d => d.primary) || displays[0];
    const area = display.workArea;
    return { display, x: Math.round(area.x + clamp(saved?.x ?? .92, 0, 1) * Math.max(0, area.width - size)),
        y: Math.round(area.y + clamp(saved?.y ?? .75, 0, 1) * Math.max(0, area.height - size - 32)) };
}
function saveAnchor(display, anchor, size) {
    const a = display.workArea;
    return { displayId: display.id, x: clamp((anchor.x-a.x)/Math.max(1,a.width-size),0,1), y:clamp((anchor.y-a.y)/Math.max(1,a.height-size-32),0,1) };
}
function layoutFor(display, anchor, size, panel = {}) {
    const a = display.workArea;
    const requestedPanelHeight = panel.editor && panel.response ? 246 : panel.editor ? 130 : panel.response ? 128 : 0;
    size = Math.max(24, Math.min(size, a.width-16, a.height-40));
    if(requestedPanelHeight) size = Math.min(size, Math.max(24, a.height-Math.min(requestedPanelHeight,Math.max(100,a.height*.55))-48));
    const panelHeight = Math.max(0, Math.min(requestedPanelHeight,a.height-size-48));
    const x = clamp(anchor.x,a.x+8,a.x+a.width-size-8);
    let y = clamp(anchor.y,a.y+8,a.y+a.height-size-32);
    const width = Math.min(a.width, Math.max(size+16, panelHeight ? 312 : size+16));
    const height = Math.min(a.height, size+40+(panelHeight ? panelHeight+8 : 0));
    const left = Math.round(clamp(x+size/2-width/2,a.x,a.x+a.width-width));
    const belowSpace=a.y+a.height-y-size, aboveSpace=y-a.y;
    const below = !panelHeight || belowSpace >= panelHeight+40 || (aboveSpace < panelHeight+16 && belowSpace>=aboveSpace);
    if(panelHeight) y = below ? clamp(y,a.y+8,a.y+a.height-size-panelHeight-40) : clamp(y,a.y+panelHeight+16,a.y+a.height-size-32);
    const top = Math.round(clamp(panelHeight && !below ? y-panelHeight-16 : y-8,a.y,a.y+a.height-height));
    const art = {x:Math.round(x-left),y:Math.round(y-top),width:size,height:size};
    const input = panelHeight ? {x:8,y:below ? art.y+size+30 : 8,width:width-16,height:panelHeight} : null;
    return {bounds:{x:left,y:top,width:Math.round(width),height:Math.round(height)},art,panel:input,
        control:{x:art.x+size/2-16,y:art.y+size+2,width:32,height:26},anchor:{x,y},size};
}
function contains(rect, p) { return !!rect && p.x>=rect.x && p.y>=rect.y && p.x<=rect.x+rect.width && p.y<=rect.y+rect.height; }
function hitLayout(layout, point) { const p={x:point.x-layout.bounds.x,y:point.y-layout.bounds.y}; return contains(layout.art,p)||contains(layout.control,p)||contains(layout.panel,p); }
module.exports={anchorFor,saveAnchor,layoutFor,hitLayout};
