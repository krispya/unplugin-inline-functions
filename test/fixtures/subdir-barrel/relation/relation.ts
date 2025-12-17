import { $relation } from './symbols';
export /* @inline */ function createRelation(x: any) {
	return { [$relation]: x };
}

