// Display owns the animation clock: prepare/decode may take arbitrarily long.
export function createPlayback({ catalog, prepare, display, schedule = setTimeout, cancel = clearTimeout }) {
    let generation = 0, timer = null, current = null, target = null;
    function stop() { generation++; if (timer !== null)
        cancel(timer); timer = null; }
    async function show(state, part, ticket, done) {
        const clip = catalog(state, part);
        if (!clip)
            return;
        try {
            const ready = await prepare(clip);
            if (ticket !== generation) {
                ready.dispose?.();
                return;
            }
            display(ready, clip);
            current = { state, part };
            if (done)
                timer = schedule(() => { timer = null; if (ticket === generation)
                    done(); }, clip.duration);
        }
        catch {
            if (ticket === generation && state !== 'idle')
                show('idle', 'main', ticket);
        }
    }
    function enter(state, ticket, celebrate) {
        const reaction = catalog(state, 'reaction') || catalog(state, 'success-reaction');
        if (state === 'terminal')
            show(state, 'entry', ticket, () => show(state, 'main', ticket));
        else if (reaction)
            show(state, reaction.part, ticket, () => show(state, 'hold', ticket, celebrate ? () => show('idle', 'main', ticket) : undefined));
        else
            show(state, 'main', ticket);
    }
    return {
        set(state, id = '', reduced = false) {
            const key = `${state}:${id}:${reduced}`;
            if (key === target)
                return;
            target = key;
            stop();
            const ticket = generation;
            if (reduced) {
                show(state, catalog(state, 'hold') ? 'hold' : 'main', ticket);
                return;
            }
            // Active work and attention interrupt terminal immediately; only quiet departure uses exit.
            if (current?.state === 'terminal' && ['idle', 'happy', 'sleepy'].includes(state))
                show('terminal', 'exit', ticket, () => enter(state, ticket, state === 'happy'));
            else
                enter(state, ticket, state === 'happy');
        }, stop,
    };
}
