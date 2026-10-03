import {z} from 'zod';

/** An explicit model-catalogue selection, not a grant or a project ACL. */
export const missionInferenceProfileSchema=z.object({
 kind:z.literal('studio_generated_coordinator'),
 version:z.literal(1),
 projectId:z.string().uuid()
}).strict();
export type MissionInferenceProfile=z.infer<typeof missionInferenceProfileSchema>;
