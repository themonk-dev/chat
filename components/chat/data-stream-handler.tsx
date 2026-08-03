"use client";

import { useEffect } from "react";
import { useDataStream } from "./data-stream-provider";

/**
 * Chat titles are no longer server-generated, so there is nothing left here to
 * revalidate a sidebar cache for — `useChats()` refreshes itself when a thread
 * is written. This just drains the stream buffer.
 */
export function DataStreamHandler() {
  const { dataStream, setDataStream } = useDataStream();

  useEffect(() => {
    if (!dataStream?.length) {
      return;
    }

    setDataStream([]);
  }, [dataStream, setDataStream]);

  return null;
}
