#!/bin/sh
# Prints the user lines among <length> bytes of a transcript from byte <from>,
# small enough to hand back to the mod, then `{"read":N}`: how many bytes the
# whole lines there span, so the next scan starts after them. A line the
# session is still writing (no newline yet) is left for the next scan.
#
# `$.fs.read` refuses files over 4 MiB and reads no byte ranges, and one prompt
# line alone can be larger (an attached PDF or image). This keeps only lines
# that could be a contribution and cuts every run of 200 or more base64
# characters (attached files, pasted images), which the counting rule never
# reads. Every line it drops, the rule in rule.ts would drop too; the rule
# itself stays in the mod.
#
# Usage: user-lines.sh <transcript.jsonl> <from> <length>
export LC_ALL=C
tail -c +$(($2 + 1)) "$1" | head -c "$3" |
  awk -v length_="$3" '
    { read += length($0) + 1; last = $0 }
    read <= length_ && index($0, "\"type\":\"user\"") && !index($0, "\"toolUseResult\":")
    END {
      if (read > length_) read -= length(last) + 1
      printf "{\"read\":%d}\n", read
    }' |
  sed -E 's#(^|[^\\])[A-Za-z0-9+/=]{200,}#\1#g'
exit 0
