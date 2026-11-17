
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { ToastProvider } from 'react-toast-master';
          import TasksView from '../../src/components/scheduled-tasks/TasksView.jsx';
          import Sidebar from '../../src/components/Sidebar.jsx';

          const START = Date.UTC(2026, 0, 1, 9);
          const NEXT = Date.UTC(2026, 0, 11, 9);
          const baseTask = (id, name, extra) => ({
            id, name, prompt: name + ' instructions for the assistant.', projectId: null,
            schedule: { type: 'daily', atTime: '09:00', startAt: START }, timezone: 'UTC',
            model: { kind: 'local', modelPath: '/models/alpha.gguf' }, fallback: [],
            missedPolicy: { policy: 'grace', graceHours: 24, maxOverdueDays: 7 },
            permissionMode: 'read_only', budget: null, enabled: true, nextRunAt: NEXT,
            lastRunAt: null, lastStatus: null, createdAt: START, updatedAt: START, ...extra,
          });
          let tasks = [
            baseTask('a', 'Alpha'),
            baseTask('b', 'Beta', { lastStatus: 'failed' }),
            baseTask('c', 'Gamma', { enabled: false }),
          ];
          let runs = [
            { id: 'r1', taskId: 'a', sessionId: 'scheduled-r1', status: 'completed', trigger: 'schedule', scheduledFor: NEXT - 86400000, startedAt: NEXT - 86400000, finishedAt: NEXT - 86400000 + 41000, model: { kind: 'local', modelPath: '/models/alpha.gguf' }, fallbackUsed: false, failureReason: null },
            { id: 'r4', taskId: 'a', status: 'blocked', trigger: 'schedule', scheduledFor: NEXT - 172800000, startedAt: NEXT - 172800000, finishedAt: NEXT - 172800000 + 2000, model: null, fallbackUsed: false, failureReason: 'approval_required: Tool approval required for write_file.' },
            { id: 'r2', taskId: 'b', status: 'failed', trigger: 'schedule', scheduledFor: NEXT - 86400000, startedAt: NEXT - 86400000, finishedAt: NEXT - 86400000 + 9000, model: null, fallbackUsed: false, failureReason: 'The model exploded.' },
            { id: 'r3', taskId: 'c', status: 'skipped', trigger: 'schedule', scheduledFor: NEXT - 86400000, startedAt: null, finishedAt: null, model: null, fallbackUsed: false, failureReason: 'The model does not fit in available GPU memory.' },
          ];
          const calls = { list: 0, history: [], create: [], update: [], pause: [], resume: [], remove: [], runNow: [], cancel: [] };
          const listeners = new Set();
          const subscriptions = { added: 0, removed: 0 };
          const clone = value => JSON.parse(JSON.stringify(value));
          const emit = event => { for (const listener of [...listeners]) listener(clone(event)); };
          const byId = id => tasks.find(task => task.id === id);

          window.calls = calls;
          window.subscriptions = subscriptions;
          window.failList = false;
          window.setTasks = next => { tasks = next; };
          window.setRuns = next => { runs = next; };
          window.initialTasks = clone(tasks);
          window.initialRuns = clone(runs);
          window.pushEvent = emit;

          window.api = { scheduledTasks: {
            list: async () => { calls.list++; if (window.failList) throw new Error('Backend unavailable'); return clone(tasks); },
            history: async (options = {}) => {
              calls.history.push({ ...options });
              const rows = runs.filter(run => (!options.taskId || run.taskId === options.taskId) && (!options.status || run.status === options.status));
              const offset = options.offset || 0;
              const limit = options.limit || 25;
              return { runs: clone(rows.slice(offset, offset + limit)), total: rows.length, limit, offset };
            },
            create: async payload => {
              calls.create.push(clone(payload));
              const task = { ...clone(payload), id: 'new-task', createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: NEXT, lastStatus: null };
              tasks.push(task); emit({ type: 'task-created', task }); return clone(task);
            },
            update: async (id, patch) => {
              calls.update.push({ id, patch: clone(patch) });
              Object.assign(byId(id), clone(patch)); const task = clone(byId(id));
              emit({ type: 'task-updated', task }); return task;
            },
            pause: async id => { calls.pause.push(id); byId(id).enabled = false; emit({ type: 'task-updated', task: clone(byId(id)) }); return clone(byId(id)); },
            resume: async id => { calls.resume.push(id); byId(id).enabled = true; emit({ type: 'task-updated', task: clone(byId(id)) }); return clone(byId(id)); },
            remove: async id => id,
            delete: async id => {
              calls.remove.push(id);
              const index = tasks.findIndex(task => task.id === id);
              if (index >= 0) tasks.splice(index, 1);
              emit({ type: 'task-deleted', taskId: id }); return { deleted: true, id };
            },
            runNow: async id => {
              calls.runNow.push(id);
              const run = { id: 'run-now-' + id, taskId: id, status: 'queued', trigger: 'manual', scheduledFor: Date.now(), startedAt: null, finishedAt: null, model: null, fallbackUsed: false, failureReason: null };
              runs = [run, ...runs]; emit({ type: 'run-created', run }); return clone(run);
            },
            cancel: async options => {
              calls.cancel.push(options.runId);
              const run = runs.find(item => item.id === options.runId);
              if (run) { run.status = 'cancelled'; run.failureReason = 'user-cancelled'; emit({ type: 'run-updated', run: clone(run) }); }
              return run ? clone(run) : null;
            },
            onEvent: listener => {
              listeners.add(listener); subscriptions.added++;
              return () => { listeners.delete(listener); subscriptions.removed++; };
            },
          } };

          function Navigation() {
            const [view, setView] = useState('chat');
            window.currentView = () => view;
            return <Sidebar
              projects={[{ id: 'p1', name: 'Proj' }]}
              view={view}
              groups={[]}
              activeId={null}
              onLoad={() => {}}
              onNew={() => setView('chat')}
              onAction={async () => {}}
              onChat={() => setView('chat')}
              onProjects={() => setView('projects')}
              onProject={() => {}}
              onCreateProject={() => {}}
              onTasks={() => setView('tasks')}
              tasksActive={view === 'tasks'}
            />;
          }

          function Harness() {
            const [mounted, setMounted] = useState(true);
            window.setMounted = setMounted;
            return <>
              <div style={{ display: 'flex', height: '100%' }}>
                <div style={{ width: 220, flexShrink: 0 }}><Navigation /></div>
                <div style={{ display: 'flex', flex: 1, minWidth: 0 }}>{mounted && <TasksView
                  models={[{ id: '/models/alpha.gguf', name: 'Local/alpha.gguf' }, { id: 'cloud:openai:gpt-4o-mini', name: 'OpenAI / gpt-4o-mini' }]}
                  projects={[{ id: 'p1', name: 'Proj' }]}
                  onOpenRun={id => { window.openedRun = id; }}
                />}</div>
              </div>
            </>;
          }
          createRoot(document.getElementById('root')).render(<ToastProvider><Harness /></ToastProvider>);
        