declare module 'twitter-text' {
  const twitterText: { parseTweet(text: string): { weightedLength: number; valid: boolean; permillage: number } };
  export default twitterText;
}
