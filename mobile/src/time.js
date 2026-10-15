// Times, like the web page: "Today", "Yesterday", "10 October 2026", and "14:03".

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

export function dayName(date) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, new Date())) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function clock(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

// Above a message: "Today at 14:03", "Yesterday at 09:12", "10 October 2026 14:03".
export function headerTime(date) {
  const day = dayName(date);
  return (day === 'Today' || day === 'Yesterday' ? day + ' at ' : day + ' ') + clock(date);
}
