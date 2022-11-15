// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect, useMemo, useState } from "react";

import Log from "@foxglove/log";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import { useCurrentLayoutActions } from "@foxglove/studio-base/context/CurrentLayoutContext";
import { PanelsState } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";
import { useCurrentUser } from "@foxglove/studio-base/context/CurrentUserContext";
import { EventsStore, useEvents } from "@foxglove/studio-base/context/EventsContext";
import { useLayoutManager } from "@foxglove/studio-base/context/LayoutManagerContext";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import useCallbackWithToast from "@foxglove/studio-base/hooks/useCallbackWithToast";
import { PlayerPresence } from "@foxglove/studio-base/players/types";
import { parseAppURLState } from "@foxglove/studio-base/util/appURLState";

const selectPlayerPresence = (ctx: MessagePipelineContext) => ctx.playerState.presence;
const selectSeek = (ctx: MessagePipelineContext) => ctx.seekPlayback;
const selectSelectEvent = (store: EventsStore) => store.selectEvent;

const log = Log.getLogger(__filename);

/**
 * Restores our session state from any deep link we were passed on startup.
 */
export function useInitialDeepLinkState(deepLinks: readonly string[]): {
  currentUserRequired: boolean;
} {
  const { selectSource } = usePlayerSelection();
  const { setSelectedLayoutId } = useCurrentLayoutActions();

  const seekPlayback = useMessagePipeline(selectSeek);
  const playerPresence = useMessagePipeline(selectPlayerPresence);
  const { currentUser } = useCurrentUser();
  const selectEvent = useEvents(selectSelectEvent);
  const layoutManager = useLayoutManager();

  const targetUrlState = useMemo(
    () => (deepLinks[0] ? parseAppURLState(new URL(deepLinks[0])) : undefined),
    [deepLinks],
  );

  // Maybe this should be abstracted somewhere but that would require a
  // more intimate interface with this hook and the player selection logic.
  const currentUserRequired = targetUrlState?.ds === "foxglove-data-platform";

  // Tracks what portions of the URL state we have yet to apply to the current session.
  const [unappliedUrlState, setUnappliedUrlState] = useState(
    targetUrlState ? { ...targetUrlState } : undefined,
  );

  const [fetchingLayout, setFetchingLayout] = useState(false);

  // Load data source from URL.
  useEffect(() => {
    if (!unappliedUrlState) {
      return;
    }

    // Wait for current user session if one is required for this source.
    if (currentUserRequired && !currentUser) {
      return;
    }

    // Apply any available datasource args
    if (unappliedUrlState.ds) {
      log.debug("Initialising source from url", unappliedUrlState);
      selectSource(unappliedUrlState.ds, {
        type: "connection",
        params: unappliedUrlState.dsParams,
      });
      selectEvent(unappliedUrlState.dsParams?.eventId);
      setUnappliedUrlState((oldState) => ({ ...oldState, ds: undefined, dsParams: undefined }));
    }
  }, [currentUser, currentUserRequired, selectEvent, selectSource, unappliedUrlState]);

  const fetchLayout = useCallbackWithToast(
    async (url: URL | RequestInfo, name: string) => {
      let res;
      try {
        res = await fetch(url instanceof URL ? url.href : url);
      } catch {
        throw `Could not load the layout from ${url}`;
      }
      if (!res.ok) {
        throw `Could not load the layout from ${url}`;
      }
      let data: PanelsState;
      try {
        data = await res.json();
      } catch {
        throw `${url} does not contain valid layout JSON`;
      }

      const layouts = await layoutManager.getLayouts();
      const sourceLayout = layouts.find((layout) => layout.name === name);

      let newLayout;
      if (sourceLayout == undefined) {
        newLayout = await layoutManager.saveNewLayout({
          name,
          data,
          permission: "CREATOR_WRITE",
        });
      } else {
        newLayout = await layoutManager.updateLayout({
          id: sourceLayout.id,
          name,
          data,
        });
      }

      setSelectedLayoutId(newLayout.id);
      setUnappliedUrlState((oldState) => ({ ...oldState, layoutUrl: undefined }));
      setFetchingLayout(false);
    },
    [setSelectedLayoutId, layoutManager],
  );

  // Select layout from URL.
  useEffect(() => {
    if (unappliedUrlState?.layoutId) {
      // If our datasource requires a current user then wait until the player is
      // available to load the layout since we may need to sync layouts first and
      // that's only possible after the user has logged in.
      if (currentUserRequired && playerPresence !== PlayerPresence.PRESENT) {
        return;
      }

      log.debug(`Initializing layout from url: ${unappliedUrlState.layoutId}`);
      setSelectedLayoutId(unappliedUrlState.layoutId);
      setUnappliedUrlState((oldState) => ({ ...oldState, layoutId: undefined }));
    }

    if (!fetchingLayout) {
      if (unappliedUrlState?.layoutUrl) {
        const url = new URL(unappliedUrlState.layoutUrl);
        const name = url.pathname.replace(/.*\//, "");
        log.debug(`Trying to load layout ${name} from ${url}`);

        setFetchingLayout(true);
        fetchLayout(url, name).catch(() => {
          return;
        });
      } else {
        log.debug("Trying to load preset layout from /config.json");
        fetchLayout("config.json", "Preset").catch(() => {
          return;
        });
      }
    }
  }, [
    currentUserRequired,
    playerPresence,
    setSelectedLayoutId,
    fetchLayout,
    fetchingLayout,
    unappliedUrlState?.layoutId,
    unappliedUrlState?.layoutUrl,
  ]);

  // Seek to time in URL.
  useEffect(() => {
    if (unappliedUrlState?.time == undefined || !seekPlayback) {
      return;
    }

    // Wait until player is ready before we try to seek.
    if (playerPresence !== PlayerPresence.PRESENT) {
      return;
    }

    log.debug(`Seeking to url time:`, unappliedUrlState.time);
    seekPlayback(unappliedUrlState.time);
    setUnappliedUrlState((oldState) => ({ ...oldState, time: undefined }));
  }, [playerPresence, seekPlayback, unappliedUrlState]);

  return useMemo(() => ({ currentUserRequired }), [currentUserRequired]);
}
