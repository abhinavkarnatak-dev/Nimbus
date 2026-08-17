import { AttachmentUploadResponseSchema, LIMITS } from '@nimbus/contracts';
import { useCallback, useRef, useState } from 'react';

import type { CsrfSource } from '../api/client.js';
import { uploadFile } from '../api/upload.js';
import { API_BASE_URL } from '../config.js';
import { newPrefixedId } from '../lib/id.js';
import {
  kindOf,
  refusalFor,
  roomFor,
  savedIds,
  uploadProblem,
  type HeldAttachment,
} from './attachments.js';

export interface AttachmentsHandle {
  held: readonly HeldAttachment[];
  refusals: readonly string[];
  add: (files: readonly File[]) => void;
  remove: (localId: string) => void;
  clear: () => void;
  readyIds: string[];
  busy: boolean;
  room: number;
}

export function useAttachments(csrf: CsrfSource): AttachmentsHandle {
  const [held, setHeld] = useState<readonly HeldAttachment[]>([]);
  const [refusals, setRefusals] = useState<readonly string[]>([]);
  const previews = useRef(new Map<string, string>());

  const change = useCallback((localId: string, patch: Partial<HeldAttachment>): void => {
    setHeld((all) => all.map((one) => (one.localId === localId ? { ...one, ...patch } : one)));
  }, []);

  const send = useCallback(
    async (localId: string, file: File): Promise<void> => {
      try {
        const answer = await uploadFile({
          baseUrl: API_BASE_URL,
          path: '/attachments',
          csrf,
          file,
          schema: AttachmentUploadResponseSchema,
          onProgress: (fraction) => {
            change(localId, { progress: fraction });
          },
        });

        change(localId, { saved: answer.attachment, progress: 1, problem: null });
      } catch (error) {
        change(localId, { problem: uploadProblem(error), progress: 0 });
      }
    },
    [csrf, change],
  );

  const add = useCallback(
    (files: readonly File[]): void => {
      setRefusals([]);

      setHeld((all) => {
        const allowed = roomFor(all.length, files.length);
        const refused: string[] = [];
        const taken: HeldAttachment[] = [];

        if (files.length > allowed) {
          refused.push(
            `Nimbus takes ${String(LIMITS.maxAttachmentsPerSession)} attachments on a session.`,
          );
        }

        for (const file of files.slice(0, allowed)) {
          const refusal = refusalFor(file);

          if (refusal !== null) {
            refused.push(refusal);
            continue;
          }

          const kind = kindOf(file.type);

          if (kind === null) {
            continue;
          }

          const localId = newPrefixedId('loc');
          const previewUrl = kind === 'image' ? URL.createObjectURL(file) : null;

          if (previewUrl !== null) {
            previews.current.set(localId, previewUrl);
          }

          taken.push({
            localId,
            name: file.name,
            byteSize: file.size,
            kind,
            previewUrl,
            progress: 0,
            saved: null,
            problem: null,
          });

          void send(localId, file);
        }

        if (refused.length > 0) {
          setRefusals(refused);
        }

        return [...all, ...taken];
      });
    },
    [send],
  );

  const forget = useCallback((localId: string): void => {
    const url = previews.current.get(localId);

    if (url !== undefined) {
      URL.revokeObjectURL(url);
      previews.current.delete(localId);
    }
  }, []);

  const remove = useCallback(
    (localId: string): void => {
      forget(localId);
      setHeld((all) => all.filter((one) => one.localId !== localId));
    },
    [forget],
  );

  const clear = useCallback((): void => {
    for (const url of previews.current.values()) {
      URL.revokeObjectURL(url);
    }
    previews.current.clear();
    setHeld([]);
    setRefusals([]);
  }, []);

  return {
    held,
    refusals,
    add,
    remove,
    clear,
    readyIds: savedIds(held),
    busy: held.some((one) => one.saved === null && one.problem === null),
    room: roomFor(held.length, LIMITS.maxAttachmentsPerSession),
  };
}
