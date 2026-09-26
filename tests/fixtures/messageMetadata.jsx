import React from 'react';
import { createRoot } from 'react-dom/client';
import AssistantMessage from '../../src/components/AssistantMessage';
const root = createRoot(document.getElementById('root'));
window.renderMessages = messages => root.render(<div>{messages.map(message =>
  <article key={message.id} data-message-id={message.id}>
    {message.role === 'assistant' ? <AssistantMessage message={message} onSelectVariant={index => window.renderMessages(messages.map(row => row.id === message.id ? { ...row, active_variant_index: index } : row))} /> : message.content}
  </article>
)}</div>);
