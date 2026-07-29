import "./env.js";

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "skybridge/server";
import { z } from "zod";
import { requiredEnv } from "./env.js";

const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY?.trim() || requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(
  requiredEnv("SUPABASE_URL"),
  supabaseSecretKey,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const mcpAuthToken = requiredEnv("MCP_AUTH_TOKEN");
const pttAdminUrl = (process.env.PTT_ADMIN_URL || "http://localhost:3000").replace(/\/+$/, "");
const pttSharedSecret = requiredEnv("PTT_MCP_SHARED_SECRET");

function authorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(mcpAuthToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function since(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function textResult(summary: string, structuredContent: Record<string, unknown>) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text: summary }],
  };
}

function databaseError(error: { message: string } | null): never | void {
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
}

const server = new McpServer(
  { name: "browser-ptt-diagnostics", version: "0.1.0" },
  { capabilities: {} },
);

server.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  if (!authorized(req.headers.authorization)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
});

server.registerTool(
  {
    name: "get_current_status",
    description: "Get the latest Browser PTT connection status for active or recently seen devices.",
    inputSchema: {
      channelId: z.string().max(80).optional(),
      username: z.string().max(80).optional(),
    },
    outputSchema: {
      statuses: z.array(z.record(z.string(), z.unknown())),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ channelId, username }) => {
    let query = supabase
      .from("ptt_current_status")
      .select("device_id,status_key,username,channel_id,session_id,peer_id,event_type,network_mode,connection_state,ice_state,candidate_type,remote_candidate_type,protocol,inbound_bytes,outbound_bytes,packets_received,packets_lost,error_name,error_message,updated_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (channelId) query = query.eq("channel_id", channelId);
    if (username) query = query.eq("username", username);
    const { data, error } = await query;
    databaseError(error);
    const statuses = data || [];
    return textResult(`Found ${statuses.length} current PTT status records.`, {
      statuses,
      count: statuses.length,
    });
  },
);

server.registerTool(
  {
    name: "get_recent_errors",
    description: "Get recent Browser PTT connection, media, TURN, and WebRTC errors.",
    inputSchema: {
      channelId: z.string().max(80).optional(),
      username: z.string().max(80).optional(),
      hours: z.number().int().min(1).max(168).default(24),
      limit: z.number().int().min(1).max(100).default(50),
    },
    outputSchema: {
      events: z.array(z.record(z.string(), z.unknown())),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ channelId, username, hours, limit }) => {
    let query = supabase
      .from("ptt_connection_events")
      .select("id,device_id,username,channel_id,peer_id,event_type,network_mode,connection_state,ice_state,candidate_type,remote_candidate_type,protocol,error_name,error_message,details,created_at")
      .in("event_type", ["ws_disconnected", "mic_error", "track_ended", "audio_play_error", "peer_error", "turn_test"])
      .gte("created_at", since(hours))
      .order("created_at", { ascending: false })
      .limit(limit);
    if (channelId) query = query.eq("channel_id", channelId);
    if (username) query = query.eq("username", username);
    const { data, error } = await query;
    databaseError(error);
    const events = data || [];
    return textResult(`Found ${events.length} PTT error events in the last ${hours} hours.`, {
      events,
      count: events.length,
    });
  },
);

server.registerTool(
  {
    name: "get_device_history",
    description: "Get bounded connection and diagnostic history for one Browser PTT device.",
    inputSchema: {
      deviceId: z.string().min(1).max(96),
      hours: z.number().int().min(1).max(720).default(24),
      limit: z.number().int().min(1).max(200).default(100),
    },
    outputSchema: {
      events: z.array(z.record(z.string(), z.unknown())),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ deviceId, hours, limit }) => {
    const { data, error } = await supabase
      .from("ptt_connection_events")
      .select("id,device_id,username,channel_id,peer_id,event_type,network_mode,connection_state,ice_state,candidate_type,remote_candidate_type,protocol,inbound_bytes,outbound_bytes,packets_received,packets_lost,error_name,error_message,details,created_at")
      .eq("device_id", deviceId)
      .gte("created_at", since(hours))
      .order("created_at", { ascending: false })
      .limit(limit);
    databaseError(error);
    const events = data || [];
    return textResult(`Found ${events.length} events for device ${deviceId}.`, {
      events,
      count: events.length,
    });
  },
);

server.registerTool(
  {
    name: "get_disconnect_summary",
    description: "Rank Browser PTT devices by disconnect and WebRTC failure count.",
    inputSchema: {
      channelId: z.string().max(80).optional(),
      hours: z.number().int().min(1).max(720).default(24),
      limit: z.number().int().min(1).max(50).default(10),
    },
    outputSchema: {
      devices: z.array(z.record(z.string(), z.unknown())),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  async ({ channelId, hours, limit }) => {
    let query = supabase
      .from("ptt_connection_events")
      .select("device_id,username,channel_id,event_type,network_mode,connection_state,ice_state,candidate_type,created_at")
      .gte("created_at", since(hours))
      .or("event_type.eq.ws_disconnected,connection_state.eq.failed,ice_state.eq.failed")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (channelId) query = query.eq("channel_id", channelId);
    const { data, error } = await query;
    databaseError(error);

    const summary = new Map<string, {
      deviceId: string;
      username: string;
      channelId: string | null;
      disconnectCount: number;
      lanFailures: number;
      wanFailures: number;
      lastFailureAt: string;
    }>();
    for (const event of data || []) {
      const existing = summary.get(event.device_id) || {
        deviceId: event.device_id,
        username: event.username,
        channelId: event.channel_id,
        disconnectCount: 0,
        lanFailures: 0,
        wanFailures: 0,
        lastFailureAt: event.created_at,
      };
      existing.disconnectCount++;
      if (event.network_mode === "lan") existing.lanFailures++;
      if (event.network_mode === "wan") existing.wanFailures++;
      summary.set(event.device_id, existing);
    }
    const devices = [...summary.values()]
      .sort((a, b) => b.disconnectCount - a.disconnectCount)
      .slice(0, limit);
    return textResult(`Ranked ${devices.length} devices by failures in the last ${hours} hours.`, {
      devices,
      count: devices.length,
    });
  },
);

server.registerTool(
  {
    name: "send_notification",
    description: "Send an administrator text notification to all currently connected users in a PTT channel.",
    inputSchema: {
      channelId: z.string().min(1).max(80),
      message: z.string().min(1).max(500),
    },
    outputSchema: {
      success: z.boolean(),
      notificationId: z.string().nullable(),
      channelId: z.string(),
      recipientCount: z.number(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  },
  async ({ channelId, message }) => {
    const response = await fetch(`${pttAdminUrl}/api/admin/notify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pttSharedSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channelId, message, actor: "MCP administrator" }),
    });
    const result = await response.json() as {
      success?: boolean;
      notificationId?: string | null;
      channelId?: string;
      recipientCount?: number;
      error?: string;
    };
    if (!response.ok) throw new Error(result.error || `PTT backend returned HTTP ${response.status}`);
    const structuredContent = {
      success: Boolean(result.success),
      notificationId: result.notificationId || null,
      channelId: result.channelId || channelId,
      recipientCount: Number(result.recipientCount || 0),
    };
    return textResult(
      `Notification sent to ${structuredContent.recipientCount} connected users in ${structuredContent.channelId}.`,
      structuredContent,
    );
  },
);

export default await server.run();
export type AppType = typeof server;
