// src/renderer/pages/team/hooks/useTeamSession.ts
import { ipcBridge } from '@/common';
import type {
  ITeamAgentRemovedEvent,
  ITeamAgentRenamedEvent,
  ITeamAgentSpawnedEvent,
  ITeamAgentStatusEvent,
  TeamAgent,
  TeammateStatus,
  TTeam,
} from '@/common/types/teamTypes';
import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';

type AgentStatusInfo = {
  slotId: string;
  status: TeammateStatus;
  lastMessage?: string;
};

export function useTeamSession(team: TTeam) {
  const { mutate: mutateTeam } = useSWR(team.id ? `team/${team.id}` : null, () =>
    ipcBridge.team.get.invoke({ id: team.id })
  );

  const [agents, setAgents] = useState<TeamAgent[]>(team.agents);
  const [statusMap, setStatusMap] = useState<Map<string, AgentStatusInfo>>(() => {
    return new Map(team.agents.map((a) => [a.slotId, { slotId: a.slotId, status: a.status }]));
  });

  useEffect(() => {
    setAgents(team.agents);
    setStatusMap((prev) => {
      const next = new Map(prev);
      for (const agent of team.agents) {
        const existing = next.get(agent.slotId);
        next.set(agent.slotId, {
          slotId: agent.slotId,
          status: existing?.status ?? agent.status,
          lastMessage: existing?.lastMessage,
        });
      }
      for (const slotId of next.keys()) {
        if (!team.agents.some((agent) => agent.slotId === slotId)) {
          next.delete(slotId);
        }
      }
      return next;
    });
  }, [team.agents]);

  const refreshTeam = useCallback(async () => {
    const freshTeam = await mutateTeam();
    if (freshTeam?.agents) {
      setAgents(freshTeam.agents);
    }
    return freshTeam;
  }, [mutateTeam]);

  useEffect(() => {
    void ipcBridge.team.ensureSession.invoke({ teamId: team.id });

    const unsubStatus = ipcBridge.team.agentStatusChanged.on((event: ITeamAgentStatusEvent) => {
      if (event.teamId !== team.id) return;
      setStatusMap((prev) => {
        const next = new Map(prev);
        next.set(event.slotId, { slotId: event.slotId, status: event.status, lastMessage: event.lastMessage });
        return next;
      });
      setAgents((prev) =>
        prev.map((agent) => (agent.slotId === event.slotId ? { ...agent, status: event.status } : agent))
      );
    });

    const unsubSpawned = ipcBridge.team.agentSpawned.on((event: ITeamAgentSpawnedEvent) => {
      if (event.teamId !== team.id) return;
      setAgents((prev) => {
        const withoutExisting = prev.filter((agent) => agent.slotId !== event.agent.slotId);
        return [...withoutExisting, event.agent];
      });
      setStatusMap((prev) => {
        const next = new Map(prev);
        next.set(event.agent.slotId, { slotId: event.agent.slotId, status: event.agent.status });
        return next;
      });
      void refreshTeam();
    });

    const unsubRemoved = ipcBridge.team.agentRemoved.on((event: ITeamAgentRemovedEvent) => {
      if (event.teamId !== team.id) return;
      setAgents((prev) => prev.filter((agent) => agent.slotId !== event.slotId));
      setStatusMap((prev) => {
        const next = new Map(prev);
        next.delete(event.slotId);
        return next;
      });
      void refreshTeam();
    });

    const unsubRenamed = ipcBridge.team.agentRenamed.on((event: ITeamAgentRenamedEvent) => {
      if (event.teamId !== team.id) return;
      setAgents((prev) =>
        prev.map((agent) => (agent.slotId === event.slotId ? { ...agent, agentName: event.newName } : agent))
      );
      void refreshTeam();
    });

    return () => {
      unsubStatus();
      unsubSpawned();
      unsubRemoved();
      unsubRenamed();
    };
  }, [team.id, refreshTeam]);

  const sendMessage = useCallback(
    async (content: string) => {
      await ipcBridge.team.sendMessage.invoke({ teamId: team.id, content });
    },
    [team.id]
  );

  const addAgent = useCallback(
    async (agent: Omit<TeamAgent, 'slotId'>) => {
      await ipcBridge.team.addAgent.invoke({ teamId: team.id, agent });
      await refreshTeam();
    },
    [team.id, refreshTeam]
  );

  const renameAgent = useCallback(
    async (slotId: string, newName: string) => {
      await ipcBridge.team.renameAgent.invoke({ teamId: team.id, slotId, newName });
      await refreshTeam();
    },
    [team.id, refreshTeam]
  );

  const removeAgent = useCallback(
    async (slotId: string) => {
      await ipcBridge.team.removeAgent.invoke({ teamId: team.id, slotId });
      await refreshTeam();
    },
    [team.id, refreshTeam]
  );

  return { agents, statusMap, sendMessage, addAgent, renameAgent, removeAgent, mutateTeam: refreshTeam };
}
