import { EventEmitter } from 'events';
import { MozDebugProtocolTransport, SocketLike } from '../mozilla/mozDebugConnection';

class MockSocket extends EventEmitter implements SocketLike {
	public receive(chunk: string) {
		this.emit('data', new Buffer(chunk))
	}
	public write(data: Buffer | string, encoding?: string) { }
}

let mockSocket = new MockSocket();
console.log(mockSocket);
let transport = new MozDebugProtocolTransport(mockSocket);
transport.on('message', console.log);

mockSocket.receive('14:{"x":0,"y":21}');
mockSocket.receive('14:{"x":1,"y":17}');
mockSocket.receive('14:{"x":1,"y":17}7:{"x":1}');
mockSocket.receive('1');
mockSocket.receive('4:');
mockSocket.receive('{"x":2,"y":16}');
mockSocket.receive('14:{"x":');
mockSocket.receive('3,"y');
mockSocket.receive('":15}1');
mockSocket.receive('3:{"x":4,');
mockSocket.receive('"y":7}');

process.exit();