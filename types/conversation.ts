export interface AgoraTokenData {
  token: string;
  uid: string;
  channel: string;
  agentId?: string;
  // The call reached Agora through the cloud proxy, so the voice channel uses it too.
  proxy?: boolean;
}

export interface ClientStartRequest {
  requester_id: string;
  channel_name: string;
  session: string;
  takeover?: boolean;
  // Defaults to employee; itdesk starts the IT desk persona.
  persona?: 'employee' | 'itdesk';
  // Answering the incoming call: the ticket it is about, or the reminder's id.
  followUp?: string;
}

export interface StopConversationRequest {
  agent_id?: string;
  session?: string;
  reason?: string;
}

export interface AgentResponse {
  agent_id: string;
  create_ts: number;
  state: string;
  max_seconds: number;
}

export interface AgoraRenewalTokens {
  rtcToken: string;
  rtmToken: string;
}
