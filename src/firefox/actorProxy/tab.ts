import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection, ActorProxy, WorkerActorProxy, IThreadActorProxy, ThreadActorProxy, SourceMappingThreadActorProxy } from '../index';
import { PendingRequests } from '../../util/pendingRequests';

let log = Log.create('TabActorProxy');

export class TabActorProxy extends EventEmitter implements ActorProxy {

	private pendingAttachRequests = new PendingRequests<IThreadActorProxy>();
	private pendingDetachRequests = new PendingRequests<void>();
	private pendingWorkersRequests = new PendingRequests<Map<string, WorkerActorProxy>>();
	private pendingReloadRequests = new PendingRequests<void>();
	private workers = new Map<string, WorkerActorProxy>();

	constructor(
		public readonly name: string,
		private _title: string,
		private _url: string,
		private readonly sourceMaps: 'client' | 'server',
		private readonly connection: DebugConnection
	) {
		super();
		this.connection.register(this);
	}

	public get title(): string {
		return this._title;
	}

	public get url(): string {
		return this._url;
	}

	public attach(): Promise<IThreadActorProxy> {

		log.debug(`Attaching to tab ${this.name}`);

		return new Promise<IThreadActorProxy>((resolve, reject) => {
			this.pendingAttachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	public detach(): Promise<void> {

		log.debug(`Detaching from tab ${this.name}`);

		return new Promise<void>((resolve, reject) => {
			this.pendingDetachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'detach' });
		});
	}

	public fetchWorkers(): Promise<Map<string, WorkerActorProxy>> {
		
		log.debug('Fetching workers');
		
		return new Promise<Map<string, WorkerActorProxy>>((resolve, reject) => {
			this.pendingWorkersRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'listWorkers' });
		});
	}

	public reload(): Promise<void> {
		
		log.debug(`Reloading ${this.name}`);
		
		return new Promise<void>((resolve, reject) => {
			this.pendingReloadRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'reload' });
		});
	}

	public dispose(): void {
		this.connection.unregister(this);
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['type'] === 'tabAttached') {

			log.debug(`Attached to tab ${this.name}`);
			let tabAttachedResponse = <FirefoxDebugProtocol.TabAttachedResponse>response;

			let threadActor: IThreadActorProxy = this.connection.getOrCreate(
				tabAttachedResponse.threadActor, 
				() => new ThreadActorProxy(tabAttachedResponse.threadActor, this.connection));

			if (this.sourceMaps === 'client') {
				threadActor = new SourceMappingThreadActorProxy(threadActor, this.connection);
			}

			this.emit('attached', threadActor);
			this.pendingAttachRequests.resolveOne(threadActor);

		} else if (response['type'] === 'exited') {

			log.debug(`Tab ${this.name} exited`);
			this.pendingAttachRequests.rejectOne("exited");

		} else if (response['type'] === 'detached') {

			log.debug(`Detached from tab ${this.name} as requested`);
			this.pendingDetachRequests.resolveOne(undefined);

		} else if (response['error'] === 'wrongState') {

			log.warn(`Tab ${this.name} was in the wrong state for the last request`);
			this.pendingDetachRequests.rejectOne("exited");

		} else if (response['type'] === 'tabDetached') {

			log.debug(`Detached from tab ${this.name} because it was closed`);
			// TODO handle pendingRequests
			this.emit('detached');

		} else if (response['type'] === 'tabNavigated') {

			if (response['state'] === 'start') {

				this._url = (<FirefoxDebugProtocol.TabWillNavigateResponse>response).url;
				log.debug(`Tab ${this.name} will navigate to ${this._url}`);
				this.emit('willNavigate');
				
			} else if (response['state'] === 'stop') {

				let didNavigateResponse = <FirefoxDebugProtocol.TabDidNavigateResponse>response;
				this._url = didNavigateResponse.url;
				this._title = didNavigateResponse.title;
				log.debug(`Tab ${this.name} did navigate to ${this._url}`);
				this.emit('didNavigate');

			}

		} else if (response['type'] === 'frameUpdate') {

			if (response['destroyAll']) {
				this.emit('framesDestroyed');
			}

		} else if (response['type'] === 'workerListChanged') {
			
			log.debug('Received workerListChanged event');
			this.emit('workerListChanged');
			
		} else if (response['workers']) {

			let workersResponse = <FirefoxDebugProtocol.WorkersResponse>response;
			let currentWorkers = new Map<string, WorkerActorProxy>();
			log.debug(`Received ${workersResponse.workers.length} workers`);

			// convert the Worker array into a map of WorkerActorProxies, re-using already 
			// existing proxies and emitting workerStarted events for new ones
			workersResponse.workers.forEach((worker) => {

				let workerActor: WorkerActorProxy;
				
				if (this.workers.has(worker.actor)) {

					workerActor = this.workers.get(worker.actor)!;

				} else {

					log.debug(`Worker ${worker.actor} started`);

					workerActor = new WorkerActorProxy(
						worker.actor, worker.url, this.sourceMaps, this.connection);
					this.emit('workerStarted', workerActor);

				}
				currentWorkers.set(worker.actor, workerActor);
			});

			// emit workerStopped events for workers that have disappeared
			this.workers.forEach((workerActor) => {
				if (!currentWorkers.has(workerActor.name)) {
					log.debug(`Worker ${workerActor.name} stopped`);
					this.emit('workerStopped', workerActor);
					workerActor.dispose();
				}
			});

			this.workers = currentWorkers;
			this.pendingWorkersRequests.resolveOne(currentWorkers);
			
		} else if (response['error'] === 'noSuchActor') {

			log.error(`No such actor ${JSON.stringify(this.name)}`);
			this.pendingAttachRequests.rejectAll('No such actor');
			this.pendingDetachRequests.rejectAll('No such actor');

		} else if (Object.keys(response).length === 1) {

			log.debug('Received response to reload request');
			this.pendingReloadRequests.resolveOne(undefined);

		} else {

			if (response['type'] === 'frameUpdate') {
				log.debug(`Ignored frameUpdate event from tab ${this.name}`);
			} else if (response['type'] === 'newSource') {
				log.debug(`Ignored newSource event from tab ${this.name}`);
			} else {
				log.warn("Unknown message from TabActor: " + JSON.stringify(response));
			}
			
		}
	}

	public onAttached(cb: (threadActor: IThreadActorProxy) => void) {
		this.on('attached', cb);
	}

	public onDetached(cb: () => void) {
		this.on('detached', cb);
	}

	public onWillNavigate(cb: () => void) {
		this.on('willNavigate', cb);
	}

	public onDidNavigate(cb: () => void) {
		this.on('didNavigate', cb);
	}

	public onFramesDestroyed(cb: () => void) {
		this.on('framesDestroyed', cb);
	}

	public onWorkerListChanged(cb: () => void) {
		this.on('workerListChanged', cb);
	}

	public onWorkerStarted(cb: (workerActor: WorkerActorProxy) => void) {
		this.on('workerStarted', cb);
	}

	public onWorkerStopped(cb: (workerActor: WorkerActorProxy) => void) {
		this.on('workerStopped', cb);
	}
}
