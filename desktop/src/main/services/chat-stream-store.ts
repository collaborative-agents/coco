import { randomUUID } from 'crypto';
import {
  readConversations,
  saveConversation,
  type StoredChatMessage,
} from '../conversation-store';
import type { TutorStreamEvent } from './tutor-stream';
import { parseAgentActivity } from '../../shared/agent-execution';

/** Main owns in-flight replies so switching/unmounting the chat cannot lose them. */
export default class ChatStreamStore {
  private readonly live = new Map<
    string,
    {
      sessionId: string;
      message: StoredChatMessage;
      transcription?: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  begin(
    sessionId: string,
    requestId: string,
    userText: string,
    images: string[] = [],
    retry = false,
    tutorModelId?: string | null,
    screenContext?: string,
  ) {
    const conversation = readConversations().find(
      (item) => item.sessionId === sessionId,
    );
    const messages = [...(conversation?.messages ?? [])];
    const message: StoredChatMessage = {
      role: 'tutor',
      text: '',
      requestId,
      isStreaming: true,
      retryText: userText,
      retryRequestKind: 'chat',
    };
    const index = messages.findIndex((item) => item.requestId === requestId);
    if (index >= 0) messages[index] = message;
    else if (retry && messages.at(-1)?.role === 'tutor')
      messages[messages.length - 1] = message;
    else {
      if (
        messages.at(-1)?.role !== 'user' ||
        messages.at(-1)?.text !== userText
      )
        messages.push({
          role: 'user',
          text: userText,
          images,
          screenContext,
          requestId: `${requestId}:user`,
        });
      messages.push(message);
    }
    this.live.set(requestId, { sessionId, message });
    saveConversation({
      sessionId,
      problem: conversation?.problem ?? '',
      tutorModelId: tutorModelId ?? conversation?.tutorModelId,
      messages,
    });
  }

  overlay(sessionId: string, messages: StoredChatMessage[]) {
    return messages.map((message) => {
      if (message.role === 'user' && message.requestId?.endsWith(':user')) {
        const run = this.live.get(message.requestId.slice(0, -5));
        if (run?.sessionId === sessionId && run.transcription !== undefined)
          return { ...message, text: run.transcription };
      }
      const live = message.requestId
        ? this.live.get(message.requestId)
        : undefined;
      return live?.sessionId === sessionId
        ? { ...message, ...live.message }
        : message;
    });
  }

  accept(requestId: string, event: TutorStreamEvent) {
    const live = this.live.get(requestId);
    if (!live) return;
    const message = live.message;
    if (event.type === 'text_delta') message.text += String(event.text ?? '');
    if (event.type === 'agent_activity') {
      message.text = String(event.text ?? message.text);
      message.activity = parseAgentActivity(event.activity);
    }
    if (event.type === 'transcription') {
      live.transcription = String(event.text ?? '');
      const conversation = readConversations().find(
        (item) => item.sessionId === live.sessionId,
      );
      if (conversation) {
        const index = conversation.messages.findIndex(
          (item) => item.requestId === requestId,
        );
        if (index > 0 && conversation.messages[index - 1].role === 'user') {
          conversation.messages[index - 1].text = String(event.text ?? '');
          saveConversation({
            ...conversation,
            messages: this.overlay(live.sessionId, conversation.messages),
          });
        }
      }
    }
    if (event.type === 'done' || event.type === 'error') {
      message.text = String(
        event.type === 'error'
          ? (event.error ?? 'The run failed.')
          : (event.guidance ?? message.text),
      );
      if (event.llm_metrics)
        message.tutorMetrics =
          event.llm_metrics as StoredChatMessage['tutorMetrics'];
      message.isStreaming = false;
      message.isError = event.type === 'error';
      message.stopped = event.stopped === true;
      message.activity = parseAgentActivity(event.activity) ?? message.activity;
      message.id = randomUUID();
      message.ts = Date.now();
    }
    if (!live.timer) live.timer = setTimeout(() => this.flush(requestId), 250);
  }

  flush(requestId: string) {
    const live = this.live.get(requestId);
    if (!live) return;
    clearTimeout(live.timer);
    live.timer = undefined;
    const conversation = readConversations().find(
      (item) => item.sessionId === live.sessionId,
    );
    if (conversation)
      saveConversation({
        ...conversation,
        messages: this.overlay(live.sessionId, conversation.messages),
      });
  }

  finish(requestId: string) {
    this.flush(requestId);
    this.live.delete(requestId);
  }
}
