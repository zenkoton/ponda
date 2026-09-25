/** 极简 ULID（时间有序、小写 Crockford base32；足够本机事件流使用） */
const ENC = "0123456789abcdefghjkmnpqrstvwxyz";

export function ulid(now: number = Date.now()): string {
	let time = now;
	let timePart = "";
	for (let i = 0; i < 10; i++) {
		timePart = ENC[time % 32] + timePart;
		time = Math.floor(time / 32);
	}
	let rand = "";
	for (let i = 0; i < 16; i++) rand += ENC[Math.floor(Math.random() * 32)];
	return timePart + rand;
}
