/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { onUnexpectedExternalError } from 'vs/base/common/errors';
import { IDisposable } from 'vs/base/common/lifecycle';
import { Position } from 'vs/editor/common/core/position';
import * as languages from 'vs/editor/common/languages';

export class ActionKind {
	private static readonly sep = '.';

	public static readonly None = new ActionKind('@@none@@'); // Special code action that contains nothing
	public static readonly Empty = new ActionKind('');
	public static readonly QuickFix = new ActionKind('quickfix');
	public static readonly Refactor = new ActionKind('refactor');
	public static readonly RefactorExtract = ActionKind.Refactor.append('extract');
	public static readonly RefactorInline = ActionKind.Refactor.append('inline');
	public static readonly RefactorMove = ActionKind.Refactor.append('move');
	public static readonly RefactorRewrite = ActionKind.Refactor.append('rewrite');
	public static readonly Source = new ActionKind('source');
	public static readonly SourceOrganizeImports = ActionKind.Source.append('organizeImports');
	public static readonly SourceFixAll = ActionKind.Source.append('fixAll');
	public static readonly SurroundWith = ActionKind.Refactor.append('surround');

	constructor(
		public readonly value: string
	) { }

	public equals(other: ActionKind): boolean {
		return this.value === other.value;
	}

	public contains(other: ActionKind): boolean {
		return this.equals(other) || this.value === '' || other.value.startsWith(this.value + ActionKind.sep);
	}

	public intersects(other: ActionKind): boolean {
		return this.contains(other) || other.contains(this);
	}

	public append(part: string): ActionKind {
		return new ActionKind(this.value + ActionKind.sep + part);
	}
}

export const enum CodeActionAutoApply {
	IfSingle = 'ifSingle',
	First = 'first',
	Never = 'never',
}

export enum CodeActionTriggerSource {
	Refactor = 'refactor',
	RefactorPreview = 'refactor preview',
	Lightbulb = 'lightbulb',
	Default = 'other (default)',
	SourceAction = 'source action',
	QuickFix = 'quick fix action',
	FixAll = 'fix all',
	OrganizeImports = 'organize imports',
	AutoFix = 'auto fix',
	QuickFixHover = 'quick fix hover window',
	OnSave = 'save participants',
	ProblemsView = 'problems view'
}

export interface CodeActionFilter {
	readonly include?: ActionKind;
	readonly excludes?: readonly ActionKind[];
	readonly includeSourceActions?: boolean;
	readonly onlyIncludePreferredActions?: boolean;
}

export function mayIncludeActionsOfKind(filter: CodeActionFilter, providedKind: ActionKind): boolean {
	// A provided kind may be a subset or superset of our filtered kind.
	if (filter.include && !filter.include.intersects(providedKind)) {
		return false;
	}

	if (filter.excludes) {
		if (filter.excludes.some(exclude => excludesAction(providedKind, exclude, filter.include))) {
			return false;
		}
	}

	// Don't return source actions unless they are explicitly requested
	if (!filter.includeSourceActions && ActionKind.Source.contains(providedKind)) {
		return false;
	}

	return true;
}

export function filtersAction(filter: CodeActionFilter, action: languages.CodeAction): boolean {
	const actionKind = action.kind ? new ActionKind(action.kind) : undefined;

	// Filter out actions by kind
	if (filter.include) {
		if (!actionKind || !filter.include.contains(actionKind)) {
			return false;
		}
	}

	if (filter.excludes) {
		if (actionKind && filter.excludes.some(exclude => excludesAction(actionKind, exclude, filter.include))) {
			return false;
		}
	}

	// Don't return source actions unless they are explicitly requested
	if (!filter.includeSourceActions) {
		if (actionKind && ActionKind.Source.contains(actionKind)) {
			return false;
		}
	}

	if (filter.onlyIncludePreferredActions) {
		if (!action.isPreferred) {
			return false;
		}
	}

	return true;
}

function excludesAction(providedKind: ActionKind, exclude: ActionKind, include: ActionKind | undefined): boolean {
	if (!exclude.contains(providedKind)) {
		return false;
	}
	if (include && exclude.contains(include)) {
		// The include is more specific, don't filter out
		return false;
	}
	return true;
}

export interface CodeActionTrigger {
	readonly type: languages.CodeActionTriggerType;
	readonly triggerAction: CodeActionTriggerSource;
	readonly filter?: CodeActionFilter;
	readonly autoApply?: CodeActionAutoApply;
	readonly context?: {
		readonly notAvailableMessage: string;
		readonly position: Position;
	};
	readonly preview?: boolean;
}

export class CodeActionCommandArgs {
	public static fromUser(arg: any, defaults: { kind: ActionKind; apply: CodeActionAutoApply }): CodeActionCommandArgs {
		if (!arg || typeof arg !== 'object') {
			return new CodeActionCommandArgs(defaults.kind, defaults.apply, false);
		}
		return new CodeActionCommandArgs(
			CodeActionCommandArgs.getKindFromUser(arg, defaults.kind),
			CodeActionCommandArgs.getApplyFromUser(arg, defaults.apply),
			CodeActionCommandArgs.getPreferredUser(arg));
	}

	private static getApplyFromUser(arg: any, defaultAutoApply: CodeActionAutoApply) {
		switch (typeof arg.apply === 'string' ? arg.apply.toLowerCase() : '') {
			case 'first': return CodeActionAutoApply.First;
			case 'never': return CodeActionAutoApply.Never;
			case 'ifsingle': return CodeActionAutoApply.IfSingle;
			default: return defaultAutoApply;
		}
	}

	private static getKindFromUser(arg: any, defaultKind: ActionKind) {
		return typeof arg.kind === 'string'
			? new ActionKind(arg.kind)
			: defaultKind;
	}

	private static getPreferredUser(arg: any): boolean {
		return typeof arg.preferred === 'boolean'
			? arg.preferred
			: false;
	}

	private constructor(
		public readonly kind: ActionKind,
		public readonly apply: CodeActionAutoApply,
		public readonly preferred: boolean,
	) { }
}

export class CodeActionItem {

	constructor(
		public readonly action: languages.CodeAction,
		public readonly provider: languages.CodeActionProvider | undefined,
	) { }

	async resolve(token: CancellationToken): Promise<this> {
		if (this.provider?.resolveCodeAction && !this.action.edit) {
			let action: languages.CodeAction | undefined | null;
			try {
				action = await this.provider.resolveCodeAction(this.action, token);
			} catch (err) {
				onUnexpectedExternalError(err);
			}
			if (action) {
				this.action.edit = action.edit;
			}
		}
		return this;
	}
}

export interface CodeActionSet extends IDisposable {
	readonly validActions: readonly CodeActionItem[];
	readonly allActions: readonly CodeActionItem[];
	readonly hasAutoFix: boolean;

	readonly documentation: readonly languages.Command[];
}

