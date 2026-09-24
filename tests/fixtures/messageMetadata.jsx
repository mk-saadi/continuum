import React from 'react';
import { createRoot } from 'react-dom/client';
import AssistantMessage from '../../src/components/AssistantMessage';
const root = createRoot(document.getElementById('root'));
window.renderMessages = messages => root.render(<div>{messages.map(message =>
  <article key={message.id} data-message-id={message.id}>
    {message.role === 'assistant' ? <AssistantMessage message={message} /> : message.content}
  </article>
)}</div>);
