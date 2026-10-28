#!/bin/bash
# Block `git commit` commands whose subject is longer than 72 characters.
# A body is allowed. Trailers are allowed and never required.
#
# Detection. The hook fires only when `git commit` is a command word: at the
# start of the command, or right after `&&`, `||`, `;`, `|`, `&`, `(`, `$(`,
# a backtick or a newline. Optional `VAR=value` prefixes and `git -C dir` /
# `git -c k=v` options are skipped. Quoted strings and heredoc bodies are
# masked before the search, so `grep "git commit"`, `echo 'git commit -m x'`
# and a heredoc that mentions `git commit` do not trigger it. Known blind
# spot: a `git commit` inside `"$( ... )"` within double quotes is masked too.
#
# Subject. Taken only from a real `-m` / `--message` argument (first one wins;
# later -m flags are body paragraphs). Handles `-m "x"`, `-m 'x'`, `-am x`,
# `-mx`, `--message=x` and `-m "$(cat <<'EOF' ... EOF)"` (first non-empty line).
#
# Skipped: --no-edit, merge commits (subject starts with `Merge `), and
# commits with no inspectable -m (editor, -F, -C, -c). The .githooks/commit-msg
# hook still sees those messages.
#
# CHECK_PREFIX=1 also requires a conventional-commit prefix (the Codex wrapper
# sets it).

MAX_SUBJECT_LENGTH=72

COMMAND=$(cat | jq -r '.tool_input.command // .command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

read -r -d '' PARSER <<'PERL'
use strict;
use warnings;
local $/;
my $cmd = <STDIN>;
$cmd = '' unless defined $cmd;
utf8::decode($cmd);
my $n = length $cmd;

# Mask quoted strings and heredoc bodies with 'Q', same length as the original,
# so offsets in the masked copy are offsets in the original.
my $m = $cmd;
my @pending;
my $i = 0;
while ($i < $n) {
  my $c = substr($cmd, $i, 1);
  if ($c eq '\\') { $i += 2; next; }
  if ($c eq "'") {
    my $j = index($cmd, "'", $i + 1);
    $j = $n - 1 if $j < 0;
    substr($m, $i, $j - $i + 1) = 'Q' x ($j - $i + 1);
    $i = $j + 1;
    next;
  }
  if ($c eq '"') {
    my $j = $i + 1;
    while ($j < $n) {
      my $d = substr($cmd, $j, 1);
      if ($d eq '\\') { $j += 2; next; }
      last if $d eq '"';
      $j++;
    }
    $j = $n - 1 if $j >= $n;
    substr($m, $i, $j - $i + 1) = 'Q' x ($j - $i + 1);
    $i = $j + 1;
    next;
  }
  if ($c eq '<' && substr($cmd, $i, 2) eq '<<' && substr($cmd, $i, 3) ne '<<<') {
    pos($cmd) = $i + 2;
    if ($cmd =~ /\G(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/gc) {
      push @pending, [$1, $3];
      $i = pos($cmd);
      next;
    }
  }
  if ($c eq "\n" && @pending) {
    $i++;
    while (my $h = shift @pending) {
      my ($dash, $tag) = @$h;
      while ($i < $n) {
        my $e = index($cmd, "\n", $i);
        my $end = $e < 0 ? $n : $e;
        my $line = substr($cmd, $i, $end - $i);
        my $cmp = $line;
        $cmp =~ s/^\t+// if $dash;
        substr($m, $i, $end - $i) = 'Q' x ($end - $i);
        $i = $e < 0 ? $n : $e + 1;
        last if $cmp eq $tag;
      }
    }
    next;
  }
  $i++;
}

sub words {
  my ($s, $i) = @_;
  my $len = length $s;
  my @w;
  while ($i < $len) {
    my $c = substr($s, $i, 1);
    if ($c =~ /[ \t]/) { $i++; next; }
    if ($c eq '\\' && substr($s, $i + 1, 1) eq "\n") { $i += 2; next; }
    last if $c =~ /[\n;&|)]/;
    my $tok = '';
    while ($i < $len) {
      $c = substr($s, $i, 1);
      last if $c =~ /[ \t\n;&|)]/;
      if ($c eq '\\') {
        my $e = substr($s, $i + 1, 1);
        $tok .= $e unless $e eq "\n";
        $i += 2;
        next;
      }
      if ($c eq "'") {
        my $j = index($s, "'", $i + 1);
        $j = $len if $j < 0;
        $tok .= substr($s, $i + 1, $j - $i - 1);
        $i = $j + 1;
        next;
      }
      if ($c eq '"') {
        my $j = $i + 1;
        my $v = '';
        while ($j < $len) {
          my $d = substr($s, $j, 1);
          if ($d eq '\\') {
            my $e = substr($s, $j + 1, 1);
            if ($e =~ /["\\\$`]/) { $v .= $e; }
            elsif ($e ne "\n") { $v .= "\\$e"; }
            $j += 2;
            next;
          }
          last if $d eq '"';
          $v .= $d;
          $j++;
        }
        $tok .= $v;
        $i = $j + 1;
        next;
      }
      $tok .= $c;
      $i++;
    }
    push @w, $tok;
  }
  return @w;
}

my $commit = qr/(?:^|[;&|\n(`])[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*git(?:[ \t]+(?:-C|-c|--git-dir|--work-tree|--exec-path)[ \t]+\S+|[ \t]+--[a-z][a-z-]*=\S+|[ \t]+--no-pager|[ \t]+-p)*[ \t]+commit(?=[ \t\n;&|)\\]|$)/;
my $prefix = qr/^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9][a-z0-9._\/-]*\))?!?: .+/;

while ($m =~ /$commit/g) {
  my @w = words($cmd, $+[0]);
  my ($msg, $skip);
  for (my $k = 0; $k < @w; $k++) {
    my $a = $w[$k];
    if ($a eq '--') { last; }
    elsif ($a eq '--no-edit') { $skip = 1; }
    elsif ($a =~ /^(?:-[FCct]|--file|--reuse-message|--reedit-message|--template)$/) { $k++; }
    elsif ($a eq '--message') { $msg = $w[$k + 1] unless defined $msg; $k++; }
    elsif ($a =~ /^--message=(.*)$/s) { $msg = $1 unless defined $msg; }
    elsif ($a =~ /^-[A-Za-z]*m$/) { $msg = $w[$k + 1] unless defined $msg; $k++; }
    elsif ($a =~ /^-m(.+)$/s) { $msg = $1 unless defined $msg; }
  }
  next if $skip || !defined $msg;
  if ($msg =~ /^\$\(\s*cat\s*<<-?\s*(['"]?)[A-Za-z_]\w*\1[^\n]*\n(.*)\z/s) { $msg = $2; }
  my ($subject) = grep { /\S/ } split /\n/, $msg;
  next unless defined $subject;
  $subject =~ s/^\s+|\s+$//g;
  next if $subject =~ /^Merge /;
  my $bad = ($ENV{CHECK_PREFIX} && $subject !~ $prefix) ? 'bad' : 'ok';
  print length($subject), "\t", $bad, "\n";
}
PERL

RESULTS=$(printf '%s' "$COMMAND" | perl -e "$PARSER" 2>/dev/null) || exit 0

ERRORS=""
while IFS=$'\t' read -r LEN PREFIX_STATE; do
  [ -z "$LEN" ] && continue
  if [ "$LEN" -gt "$MAX_SUBJECT_LENGTH" ]; then
    ERRORS="Subject line is ${LEN} chars (max ${MAX_SUBJECT_LENGTH})."
    break
  fi
  if [ "$PREFIX_STATE" = "bad" ]; then
    ERRORS="Subject must use Conventional Commits, e.g. fix(api): handle token refresh."
    break
  fi
done <<< "$RESULTS"

if [ -n "$ERRORS" ]; then
  REASON="BLOCKED: ${ERRORS} Keep the subject line to ${MAX_SUBJECT_LENGTH} chars or fewer. A body is allowed."
  jq -n --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi
exit 0
