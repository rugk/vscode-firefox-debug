import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { ExceptionBreakpoints, IThreadActorProxy, ConsoleActorProxy } from '../../firefox/index';
import { ThreadPauseCoordinator, PauseType } from './threadPause';
import { DelayedTask } from '../../util/delayedTask';
import { PendingRequest } from '../../util/pendingRequests';

let log = Log.create('ThreadCoordinator');

type ThreadState = 'paused' | 'resuming' | 'running' | 'interrupting' | 'evaluating';

type ThreadTarget = 'paused' | 'running' | 'stepOver' | 'stepIn' | 'stepOut';

export class ThreadCoordinator extends EventEmitter {

	private exceptionBreakpoints: ExceptionBreakpoints;

	private threadState: ThreadState = 'paused';

	private _threadTarget: ThreadTarget = 'paused';
	public get threadTarget(): ThreadTarget {
		return this._threadTarget;
	}

	private _threadPausedReason?: FirefoxDebugProtocol.ThreadPausedReason;
	public get threadPausedReason(): FirefoxDebugProtocol.ThreadPausedReason | undefined {
		return this._threadPausedReason;
	}

	private interruptPromise?: Promise<void>;
	private pendingInterruptRequest?: PendingRequest<void>;

	private resumePromise?: Promise<void>;
	private pendingResumeRequest?: PendingRequest<void>;

	private queuedTasksToRunOnPausedThread: DelayedTask<any>[] = [];
	private tasksRunningOnPausedThread = 0;

	private queuedEvaluateTasks: DelayedTask<FirefoxDebugProtocol.Grip>[] = [];

	constructor(
		private threadId: number,
		private threadName: string,
		private threadActor: IThreadActorProxy,
		private consoleActor: ConsoleActorProxy,
		private pauseCoordinator: ThreadPauseCoordinator,
		private prepareResume: () => Promise<void>) {

		super();

		threadActor.onPaused((event) => {

			if (this.threadState === 'evaluating') {

				threadActor.resume(this.exceptionBreakpoints);

			} else if ((event.why.type === 'exception') && 
						(this.exceptionBreakpoints === ExceptionBreakpoints.None)) {

				threadActor.resume(this.exceptionBreakpoints);

			} else {

				this._threadTarget = 'paused';
				this._threadPausedReason = event.why;
				this.threadPaused('user');
				this.emit('paused', event);

			}
		});

		threadActor.onResumed(() => {

			this._threadTarget = 'running';
			this._threadPausedReason = undefined;
			this.threadResumed();

			if (this.tasksRunningOnPausedThread > 0) {
				log.warn('Thread resumed unexpectedly while tasks that need the thread to be paused were running');
			}
		});
	}

	public setExceptionBreakpoints(exceptionBreakpoints: ExceptionBreakpoints) {
		this.exceptionBreakpoints = exceptionBreakpoints;
		if ((this.threadState === 'resuming') || (this.threadState === 'running')) {
			this.runOnPausedThread(async () => undefined);
		}
	}

	public interrupt(): Promise<void> {

		if (this.threadState === 'paused') {

			return Promise.resolve();

		} else if (this.interruptPromise !== undefined) {

			return this.interruptPromise;

		} else {

			this._threadTarget = 'paused';
			this._threadPausedReason = undefined;
			this.interruptPromise = new Promise<void>((resolve, reject) => {
				this.pendingInterruptRequest = { resolve, reject };
			});
			this.doNext();
			return this.interruptPromise;

		}
	}

	public resume(): Promise<void> {
		return this.resumeTo('running');
	}

	public stepOver(): Promise<void> {
		return this.resumeTo('stepOver');
	}

	public stepIn(): Promise<void> {
		return this.resumeTo('stepIn');
	}

	public stepOut(): Promise<void> {
		return this.resumeTo('stepOut');
	}

	private resumeTo(target: 'running' | 'stepOver' | 'stepIn' | 'stepOut'): Promise<void> {

		if (this.threadState === 'running') {

			if (target !== 'running') {
				log.warn(`Can't ${target} because the thread is already running`);
			}

			return Promise.resolve();

		} else if (this.resumePromise !== undefined) {

			if (target !== 'running') {
				log.warn(`Can't ${target} because the thread is already resuming`);
			}

			return this.resumePromise;

		} else {

			this._threadTarget = target;
			this._threadPausedReason = undefined;
			this.resumePromise = new Promise<void>((resolve, reject) => {
				this.pendingResumeRequest = { resolve, reject };
			});
			this.doNext();
			return this.resumePromise;

		}
	}

	public runOnPausedThread<T>(task: () => Promise<T>): Promise<T> {

		let delayedTask = new DelayedTask(task);
		this.queuedTasksToRunOnPausedThread.push(delayedTask);
		this.doNext();
		return delayedTask.promise;
	}

	public evaluate(
		expr: string,
		frameActorName: string | undefined
	): Promise<FirefoxDebugProtocol.Grip> {

		let delayedTask = new DelayedTask(() => this.consoleActor.evaluate(expr, frameActorName));

		this.queuedEvaluateTasks.push(delayedTask);
		this.doNext();

		return delayedTask.promise;
	}

	public onPaused(cb: (event: FirefoxDebugProtocol.ThreadPausedResponse) => void) {
		this.on('paused', cb);
	}

	private doNext(): void {

		if (log.isDebugEnabled()) {
			log.debug(`state: ${this.threadState}, target: ${this.threadTarget}, tasks: ${this.tasksRunningOnPausedThread}/${this.queuedTasksToRunOnPausedThread.length}, eval: ${this.queuedEvaluateTasks.length}`)
		}

		if ((this.threadState === 'interrupting') ||
			(this.threadState === 'resuming') ||
			(this.threadState === 'evaluating')) {
			return;
		}

		if (this.threadState === 'running') {

			if ((this.queuedTasksToRunOnPausedThread.length > 0) || (this.queuedEvaluateTasks.length > 0)) {
				this.executeInterrupt('auto');
				return;
			}
 
			if (this.threadTarget === 'paused') {
				this.executeInterrupt('user');
				return;
			}

		} else { // this.threadState === 'paused'

			if (this.queuedTasksToRunOnPausedThread.length > 0) {

				for (let task of this.queuedTasksToRunOnPausedThread) {
					this.executeOnPausedThread(task);
				}
				this.queuedTasksToRunOnPausedThread = [];

				return;
			}

			if (this.tasksRunningOnPausedThread > 0) {
				return;
			}

			if (this.queuedEvaluateTasks.length > 0) {

				let task = this.queuedEvaluateTasks.shift()!;
				this.executeEvaluateTask(task);

				return;
			}
		}

		if ((this.threadState === 'paused') && (this.threadTarget !== 'paused')) {
			this.executeResume();
			return;
		}
	}

	private async executeInterrupt(pauseType: PauseType): Promise<void> {

		this.threadState = 'interrupting';

		try {

			await this.pauseCoordinator.requestInterrupt(this.threadId, this.threadName, pauseType);
			await this.threadActor.interrupt(pauseType === 'auto');
			this.threadPaused(pauseType);

		} catch(e) {
			log.error(`interrupt failed: ${e}`);
			this.threadState = 'running';
			this.pauseCoordinator.notifyInterruptFailed(this.threadId, this.threadName);
		}

		this.interruptPromise = undefined;

		this.doNext();
	}

	private async executeResume(): Promise<void> {

		try {

			await this.pauseCoordinator.requestResume(this.threadId, this.threadName);

		} catch(e) {

			log.error(`resume denied: ${e}`);

			if (this.pendingResumeRequest !== undefined) {
				this.pendingResumeRequest.reject(e);
				this.pendingResumeRequest = undefined;
			}
			this.resumePromise = undefined;
		}

		let resumeLimit = this.getResumeLimit();
		this.threadState = 'resuming';

		try {

			await this.prepareResume();
			await this.threadActor.resume(this.exceptionBreakpoints, resumeLimit);
			this.threadResumed();

		} catch(e) {
			log.error(`resume failed: ${e}`);
			this.threadState = 'paused';
			this.pauseCoordinator.notifyResumeFailed(this.threadId, this.threadName);
		}

		this.doNext();
	}

	private async executeOnPausedThread(task: DelayedTask<any>): Promise<void> {

		if (this.threadState !== 'paused') {
			log.error(`executeOnPausedThread called but threadState is ${this.threadState}`);
			return;
		}

		this.tasksRunningOnPausedThread++;
		try {
			await task.execute();
		} catch(e) {
			log.warn(`task running on paused thread failed: ${e}`);
		}
		this.tasksRunningOnPausedThread--;

		if (this.tasksRunningOnPausedThread === 0) {
			this.doNext();
		}
	}

	private async executeEvaluateTask(task: DelayedTask<FirefoxDebugProtocol.Grip>): Promise<void> {

		if (this.threadState !== 'paused') {
			log.error(`executeEvaluateTask called but threadState is ${this.threadState}`);
			return;
		}
		if (this.tasksRunningOnPausedThread > 0) {
			log.error(`executeEvaluateTask called but tasksRunningOnPausedThread is ${this.tasksRunningOnPausedThread}`);
			return;
		}

		this.threadState = 'evaluating';
		try {
			await task.execute();
		} catch(e) {
		}
		this.threadState = 'paused';

		this.doNext();
	}

	private threadPaused(pauseType: PauseType): void {

		this.threadState = 'paused';

		if (this.pendingInterruptRequest !== undefined) {
			this.pendingInterruptRequest.resolve(undefined);
			this.pendingInterruptRequest = undefined;
		}
		this.interruptPromise = undefined;

		if (this.threadTarget === 'paused') {
			if (this.pendingResumeRequest !== undefined) {
				this.pendingResumeRequest.reject(undefined);
				this.pendingResumeRequest = undefined;
			}
			this.resumePromise = undefined;
		}

		this.pauseCoordinator.notifyInterrupted(this.threadId, this.threadName, pauseType);
	}

	private threadResumed(): void {

		this.threadState = 'running';

		if (this.pendingResumeRequest !== undefined) {
			this.pendingResumeRequest.resolve(undefined);
			this.pendingResumeRequest = undefined;
		}
		this.resumePromise = undefined;

		if (this.threadTarget !== 'paused') {
			if (this.pendingInterruptRequest !== undefined) {
				this.pendingInterruptRequest.reject(undefined);
				this.pendingInterruptRequest = undefined;
			}
			this.interruptPromise = undefined;
		}

		this.pauseCoordinator.notifyResumed(this.threadId, this.threadName);
	}

	private getResumeLimit(): 'next' | 'step' | 'finish' | undefined {
		switch (this.threadTarget) {
			case 'stepOver':
				return 'next';
			case 'stepIn':
				return 'step';
			case 'stepOut':
				return 'finish';
			default:
				return undefined;
		}
	}
}
