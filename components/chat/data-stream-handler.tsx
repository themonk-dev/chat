"use client";

import { useEffect } from "react";
import { useDataStream } from "./data-stream-provider";

/** Drains the stream buffer; there is no sidebar cache left to revalidate. */
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
