/** Public interaction vocabulary; arbitrary text and client timestamps are never accepted. */
export const MOTION_MODES=['walk','run','teleport'] as const;
export const EMOTE_VALUES=['wave','dance'] as const;
export const REACTION_VALUES=['wave','applause','heart','idea','celebrate','coffee'] as const;
export const INTERACTION_TTL_SECONDS=8;
export type MotionMode=typeof MOTION_MODES[number];
export type InteractionCommand={type:'emote';value:typeof EMOTE_VALUES[number]}|{type:'reaction';value:typeof REACTION_VALUES[number]};
export type PresenceInteraction=InteractionCommand&{id:string;createdAt:string;expiresAt:string};
export type PresenceActionCommand={x?:number;z?:number;motionMode?:MotionMode;seatId?:string|null;interaction?:InteractionCommand};
