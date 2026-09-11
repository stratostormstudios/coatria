/** Browser-safe conversation wire types. Sequence strings preserve PostgreSQL bigint precision. */
export const MESSAGE_REACTIONS=['thumbsup','heart','applause','laugh','idea','celebrate'] as const;
export type MessageReaction=typeof MESSAGE_REACTIONS[number];
export type ConversationActorView={kind:'human'|'agent';id:string;name:string;avatarColor:string|null};
export type ConversationMessage={
 id:string;conversationId:string;roomId:string|null;parentId:string|null;clientId:string|null;sequence:string;lastEventSequence:string;
 body:string;createdAt:string;editedAt:string|null;deletedAt:string|null;revision:number;
 userId:string|null;agentId:string|null;authorName:string;actor:ConversationActorView;
 reactions:Array<{emoji:MessageReaction;count:number;mine:boolean}>;replyCount:number;
};
export type ConversationSummary={id:string;channel:string;roomId:string|null;name:string;lastSequence:string;readSequence:string;unreadCount:number};
export type ConversationHistory={conversation:ConversationSummary;messages:ConversationMessage[];nextBefore:string|null;hasMore:boolean};
export type ConversationEvent={sequence:string;type:'message.created'|'message.edited'|'message.deleted'|'reaction.changed'|'read.updated';messageId:string|null;message:ConversationMessage|null;parentMessage?:ConversationMessage|null;read?:{actor:ConversationActorView;sequence:string};createdAt:string};
export type ConversationSync={events:ConversationEvent[];cursor:string;lastSequence:string;hasMore:boolean;resetRequired:boolean};
