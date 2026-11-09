const listeners = new Set(), sessions = new Map();
let foreground = null, snapshot = { state: 'idle', id: 'idle', busy: false };
export const subscribeMascotActivity = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getMascotActivity = () => snapshot;
export function chooseActivity(s) {
    if (s.attention)
        return { state: 'confused', id: 'attention', busy: true };
    if (s.active) {
        const active = [...s.tools.values()].filter(t => ['pending', 'running', 'preparing'].includes(t.status));
        const names = active.map(t => t.toolName || t.functionName || '');
        if (active.some(t => t.serverName === 'terminal') || names.some(n => /^(run_command|run_script|execute_command|execute_code|shell|bash|terminal|run_shell_command|exec_command|start_background_command|build_project|run_tests|get_command_status|stop_background_command)$/.test(n)))
            return { state: 'terminal', busy: true };
        if (names.some(n => /^(spawn_sub_agent|wait_for_agent|wait_for_agents|send_agent_message)$/.test(n)))
            return { state: 'analytical', busy: true };
        if (active.length)
            return { state: names.some(n => /search|retrieve/.test(n)) ? 'thinking-scan' : 'working', busy: true };
        if (s.recoverable)
            return { state: 'error-nan', busy: true };
        return { state: s.phase || 'thinking', busy: true };
    }
    if (s.preparing) return {state:'thinking',busy:true};
    return { state: s.outcome === 'completed' && !s.settled ? 'happy' : s.outcome === 'interrupted' ? 'error-xx' : 'idle', busy: false };
}
export const activityPriority = Object.freeze({ confused: 100, 'error-xx': 100, terminal: 80, analytical: 70, 'thinking-scan': 60, working: 50, 'error-nan': 45, thinking: 30, happy: 20, idle: 0, sleepy: 0 });
let handoffTimer = null, pendingKey = null;
function publish(immediate = false) {
    const s = sessions.get(foreground);
    const value = s ? { ...chooseActivity(s), id: s.requestId || 'idle', reply: s.previewText || '' } : { state: 'idle', id: 'idle', busy: false };
    const key = JSON.stringify(value);
    // Bridge short gaps between tool completion and the next structured event.
    // Attention resolution, request endings and new work always reconcile immediately.
    const defer = !immediate && value.busy && snapshot.busy && value.id === snapshot.id && snapshot.state !== 'confused' && activityPriority[value.state] < activityPriority[snapshot.state];
    if (defer) {
        if (pendingKey !== key) {
            clearTimeout(handoffTimer);
            pendingKey = key;
            handoffTimer = setTimeout(() => { pendingKey = null; publish(true); }, 140);
            handoffTimer.unref?.();
        }
        return;
    }
    clearTimeout(handoffTimer);
    pendingKey = null;
    if (key !== JSON.stringify(snapshot)) {
        snapshot = value;
        listeners.forEach(fn => fn());
    }
}
export function selectMascotSession(id) { foreground = id; publish(); }
export function mascotBusy(sessionId, busy) { const s=sessions.get(sessionId)||{tools:new Map()}; s.preparing=busy;sessions.set(sessionId,s);publish(); }
export function mascotAttention(sessionId, attention) { const s = sessions.get(sessionId) || { tools: new Map() }; s.attention = attention; sessions.set(sessionId, s); publish(); }
export function mascotEvent(sessionId, requestId, event) {
    let s = sessions.get(sessionId);
    if (event.type === 'begin') {
        if (s?.settleTimer)
            clearTimeout(s.settleTimer);
        s = { preparing: s?.preparing || false, requestId, active: true, tools: new Map(), phase: 'thinking', attention: false };
        sessions.set(sessionId, s);
    }
    if (!s || s.requestId !== requestId)
        return;
    if (event.type === 'tool') {
        s.tools.set(event.id, event);
        s.recoverable = event.status === 'error';
    }
    if (event.type === 'step-update') {
        for (const t of event.executionSteps || [])
            if (t.type === 'tool_call')
                s.tools.set(t.id, t);
    }
    if (event.type === 'text') {
        s.phase = 'working';
        s.previewText = ((s.previewText || '') + String(event.delta || '')).slice(0,12000);
        s.recoverable = false;
    }
    if (event.type === 'thinking')
        s.phase = 'thinking';
    if (event.type === 'indexing' && event.progress !== null)
        s.phase = 'thinking-scan';
    if (typeof event.reply === 'string') s.previewText = event.reply.slice(0,12000);
    if (event.type === 'end' && !s.outcome) {
        s.active = false;
        s.outcome = event.outcome;
        s.tools.clear();
    }
    if (event.type === 'task-outcome' && !event.parentRunId && !event.subagentId) {
        s.active = false;
        s.outcome = event.outcome;
        s.tools.clear();
    }
    if (s.outcome === 'completed' && !s.settleTimer) {
        s.settleTimer = setTimeout(() => { s.settled = true; publish(); }, 8000);
        s.settleTimer.unref?.();
    }
    publish();
}
export function shouldSleep(activity, elapsed, minutes) { return minutes > 0 && !activity.busy && activity.state === 'idle' && elapsed >= minutes * 60000; }

export function mascotRequestFailure(sessionId, id, message) {
    const previous=sessions.get(sessionId);
    if(previous?.settleTimer)clearTimeout(previous.settleTimer);
    sessions.set(sessionId,{requestId:id,active:false,preparing:false,outcome:'interrupted',tools:new Map(),previewText:String(message||'The request could not finish.').slice(0,12000)});
    publish();
}
