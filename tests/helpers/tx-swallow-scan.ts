import ts from 'typescript';

// -----------------------------------------------------------------------------
// Find database errors swallowed inside an interactive transaction.
//
// In PostgreSQL a failed statement aborts the transaction. A handler that does
// not rethrow lets the callback return normally, and the COMMIT then rolls back
// everything, including what ran before the error, while the caller is told it
// worked. #114 found exactly that in PATCH /api/appointments/[id]: a failed
// waitlist fan-out erased the cancellation behind a 200.
//
// Two shapes, both only where a transaction client is in scope:
//   catch-on-tx-call  `tx.<…>(…).catch(handler)`, handler not rethrowing
//   try-catch-in-tx   `try { … tx … } catch { … }` (the client used directly or
//                     handed to a helper), the catch neither
//                     rethrowing, nor calling a function declared to return
//                     `never` (mapPrismaError), nor rolling back to a savepoint
//
// A savepoint is the one correct way to tolerate a failure inside a
// transaction (notifyWaitlistAfterCancel, deleteUnlessReferenced).
// -----------------------------------------------------------------------------

export type Swallow = { file: string; line: number; shape: 'catch-on-tx-call' | 'try-catch-in-tx' };

const TX_SCOPE_CALL = /(^|\.)(withOrg|withOrgReplica|withoutRls|\$transaction)$/;

function neverReturning(sources: ts.SourceFile[]): Set<string> {
  const names = new Set<string>();
  for (const sf of sources) {
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.type?.kind === ts.SyntaxKind.NeverKeyword) {
        names.add(n.name.text);
      }
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
        n.initializer.type?.kind === ts.SyntaxKind.NeverKeyword
      ) {
        names.add(n.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return names;
}

/** Inside a transaction callback, or a function that takes the client as `tx`. */
function inTransactionScope(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (
      ts.isCallExpression(p) &&
      TX_SCOPE_CALL.test(p.expression.getText(sf)) &&
      p.arguments.some((a) => node.pos >= a.pos && node.end <= a.end)
    ) {
      return true;
    }
    if (ts.isFunctionLike(p) && p.parameters.some((q) => q.name.getText(sf) === 'tx')) return true;
  }
  return false;
}

/** Does this handler, or catch block, end the error's journey properly? */
function rethrows(body: ts.Node, sf: ts.SourceFile, never: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isThrowStatement(n)) found = true;
    else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      never.has(n.expression.text)
    ) {
      found = true;
    } else if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      /ROLLBACK TO SAVEPOINT/i.test(n.text)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

export function scanForSwallows(files: Array<{ path: string; text: string }>): Swallow[] {
  const sources = files.map((f) =>
    ts.createSourceFile(
      f.path,
      f.text,
      ts.ScriptTarget.Latest,
      true,
      f.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  );
  const never = neverReturning(sources);
  const found: Swallow[] = [];
  for (const sf of sources) {
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const visit = (n: ts.Node) => {
      // tx.<…>(…).catch(handler)
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'catch' &&
        ts.isCallExpression(n.expression.expression) &&
        /^tx\s*\./.test(n.expression.expression.expression.getText(sf)) &&
        !(n.arguments[0] && rethrows(n.arguments[0], sf, never))
      ) {
        found.push({ file: sf.fileName, line: lineOf(n), shape: 'catch-on-tx-call' });
      }
      // try { … tx.<…>(…) … } catch { … }
      if (
        ts.isTryStatement(n) &&
        n.catchClause &&
        // Any use of the client, not only a direct call: #114's swallow wrapped
        // a helper that was HANDED `tx`, and its statements failed inside it.
        /\btx\b/.test(n.tryBlock.getText(sf)) &&
        inTransactionScope(n, sf) &&
        !rethrows(n.catchClause.block, sf, never)
      ) {
        found.push({ file: sf.fileName, line: lineOf(n), shape: 'try-catch-in-tx' });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}
