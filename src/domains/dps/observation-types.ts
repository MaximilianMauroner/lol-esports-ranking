export interface RiotItemEvent {
  type: "ITEM_PURCHASED" | "ITEM_SOLD" | "ITEM_DESTROYED" | "ITEM_UNDO" | string;
  timestamp: number;
  participantId?: number;
  itemId?: number;
  beforeId?: number;
  afterId?: number;
}

export interface ChampionStatsFrame {
  healthMax: number;
  armor: number;
  magicResist: number;
  attackDamage?: number;
  attackSpeed?: number;
  abilityPower?: number;
}

export interface ParticipantFrame {
  participantId: number;
  level: number;
  totalGold: number;
  currentGold: number;
  championStats: ChampionStatsFrame;
}

export interface TimelineFrame {
  timestamp: number;
  participantFrames: Record<string, ParticipantFrame>;
  events: RiotItemEvent[];
}

export interface RiotTimeline {
  metadata: { matchId: string };
  info: { frames: TimelineFrame[]; frameInterval: number };
}
