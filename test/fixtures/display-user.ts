import { getUser, getUserName, logUserActivity } from './user-utils.js';

// Function that uses the inlined functions
export function displayUserInfo(userId: number) {
	const greeting = `Hello, ${getUserName(getUser(userId))}!`;
	const status = getUser(userId)?.active ? 'Active' : 'Inactive';
	return `${greeting} Status: ${status}`;
}

// Function with inverted control flow and inline call as statement
export function updateUserStatus(userId: number, action: string) {
	if (!getUser(userId)) return;

	const user = getUser(userId);
	if (!user?.active) return;

	// Inline annotation at call site
	/* @inline */ logUserActivity(userId, action);
}
