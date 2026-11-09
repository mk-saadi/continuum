import React,{useEffect,useRef,useState} from 'react';
import {LuMessageSquare,LuSend,LuX,LuSquare,LuExternalLink} from 'react-icons/lu';
import MascotArtwork from './MascotArtwork';
import {useReducedAnimation} from './FloatingMascot';
import {label} from './catalog';
import './desktopMascot.css';

export default function DesktopMascot(){
    const [snapshot,setSnapshot]=useState(null),[text,setText]=useState(''),[error,setError]=useState(''),[sleeping,setSleeping]=useState(false),[focused,setFocused]=useState(false),[visible,setVisible]=useState(!document.hidden);
    const drag=useRef(null),frame=useRef(null),input=useRef(null),lastActivity=useRef(Date.now());
    const api=window.mascotAPI;
    const reduced=useReducedAnimation(snapshot?.settings.animation||'system');
    useEffect(()=>{
        document.documentElement.classList.add('desktop-mascot-document');
        if(!api)return;
        let mounted=true;
        const off=api.onState(value=>{if(mounted)setSnapshot(value)});
        api.getState().then(value=>{if(mounted)setSnapshot(value)}).catch(e=>setError(e.message));
        return()=>{mounted=false;off();cancelAnimationFrame(frame.current);document.documentElement.classList.remove('desktop-mascot-document')};
    },[]);
    useEffect(()=>{const change=()=>setVisible(!document.hidden);document.addEventListener('visibilitychange',change);return()=>document.removeEventListener('visibilitychange',change)},[]);
    const activity=snapshot?.activity;
    useEffect(()=>{lastActivity.current=Date.now();setSleeping(false)},[activity?.state,activity?.id,activity?.busy]);
    useEffect(()=>{
        if(!snapshot?.settings.enabled)return;
        const wake=()=>{lastActivity.current=Date.now();setSleeping(false)};
        window.addEventListener('pointerdown',wake);window.addEventListener('keydown',wake);
        const timer=setInterval(()=>{
            setSleeping(!activity?.busy&&activity?.state==='idle'&&snapshot.settings.sleep>0&&Date.now()-lastActivity.current>=snapshot.settings.sleep*60000);
        },1000);
        return()=>{clearInterval(timer);window.removeEventListener('pointerdown',wake);window.removeEventListener('keydown',wake)};
    },[activity?.busy,activity?.state,snapshot?.settings.sleep,snapshot?.settings.enabled]);
    // Layout state comes from main, including which panel is open.
    useEffect(()=>{if(snapshot?.panel?.editor)input.current?.focus()},[snapshot?.panel?.editor]);
    if(!snapshot?.layout||!snapshot.settings.enabled||!visible)return null;
    const {settings,layout,direction,hovered,target,submitting}=snapshot;
    const showEditor=!!snapshot.panel?.editor,showResponse=!!snapshot.panel?.response;
    const busy=!!activity?.busy||submitting;
    const state=sleeping&&!busy&&activity.state==='idle'?'sleepy':activity.state;
    const changePanel=patch=>api.setPanel({editor:showEditor,response:showResponse,...patch}).catch(e=>setError(e.message));
    function start(event){
        if(event.button!==0||settings.locked)return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current={id:event.pointerId,x:event.screenX,y:event.screenY,moved:false};
    }
    function move(event){
        const current=drag.current;
        if(!current||current.id!==event.pointerId||settings.locked)return;
        if(!current.moved){if(Math.hypot(event.screenX-current.x,event.screenY-current.y)<5)return;current.moved=true;api.startDrag().catch(e=>setError(e.message))}
        if(frame.current)return;
        frame.current=requestAnimationFrame(()=>{frame.current=null;api.moveDrag().catch(()=>{})});
    }
    function end(event){
        const current=drag.current;if(!current||current.id!==event.pointerId)return;
        drag.current=null;cancelAnimationFrame(frame.current);frame.current=null;
        if(current.moved)api.moveDrag().then(()=>api.endDrag()).catch(e=>setError(e.message));
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    }
    function keyboard(event){
        if((event.shiftKey&&event.key==='F10')||event.key==='ContextMenu'){event.preventDefault();api.contextMenu();return}
        const direction={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'}[event.key];
        if(direction){event.preventDefault();api.move({direction,large:event.shiftKey})}
    }
    async function send(event){
        event.preventDefault();if(!text.trim()||busy)return;
        try{await api.submit(text);setText('');setError('')}catch(e){setError(e.message);changePanel({editor:true})}
    }
    return <div className="desktop-mascot" onContextMenu={event=>{event.preventDefault();api.contextMenu()}}>
        <button className="desktop-mascot-art" aria-label={`Continuum mascot: ${label(state)}. Right-click for options.`}
            style={{left:layout.art.x,top:layout.art.y,width:layout.art.width,height:layout.art.height,cursor:settings.locked?'default':'grab'}}
            onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={keyboard}
            onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}>
            <MascotArtwork state={state} id={activity.id} size={layout.size} hue={settings.hue} direction={direction} reduced={reduced}/>
        </button>
        {(hovered||focused||showEditor)&&<button className="desktop-mascot-compose" aria-label="Write a prompt" title="Write a prompt"
            style={{left:layout.control.x,top:layout.control.y,width:layout.control.width,height:layout.control.height}}
            onClick={()=>{setError('');changePanel({editor:!showEditor})}}><LuMessageSquare size={14}/></button>}
        {layout.panel&&<section className="desktop-mascot-panel" aria-label="Continuum quick chat"
            style={{left:layout.panel.x,top:layout.panel.y,width:layout.panel.width,maxHeight:layout.panel.height}}>
            <header><span title={target?.name}>Continuum · {busy?'Working…':target?.name||'Quick chat'}</span>
                <button aria-label="Open full chat" title="Open full chat" onClick={()=>api.openMain()}><LuExternalLink size={12}/></button>
                <button aria-label="Close quick chat" onClick={()=>changePanel({editor:false,response:false})}><LuX size={12}/></button></header>
            {showResponse&&<div className="desktop-mascot-reply" aria-label="Agent response" tabIndex={0}>{activity.reply||error||(activity.state==='confused'?'The agent needs your input.':activity.state==='error-xx'?'This request could not finish. Open the full chat for details.':'Waiting for the agent…')}</div>}
            {activity.state==='confused'&&<button className="desktop-mascot-attention" onClick={()=>api.openMain()}>Your input is needed · Open Continuum</button>}
            {showEditor&&<form onSubmit={send}>
                <textarea ref={input} aria-label="Prompt Continuum" placeholder={target?.ready?'Ask Continuum…':'Choose a model in Continuum first'} value={text}
                    maxLength={32000} onChange={event=>setText(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send(event)}}}/>
                <footer><span>{error||(!target?.ready?target?.reason:'Enter to send · Shift+Enter for a new line')}</span>
                    <button type="submit" aria-label="Send prompt" disabled={busy||!text.trim()||!target?.ready}><LuSend size={13}/></button></footer>
            </form>}
            {busy&&<button className="desktop-mascot-stop" onClick={()=>api.cancel()}><LuSquare size={10}/> Stop</button>}
        </section>}

    </div>;
}
