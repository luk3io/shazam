Intro:

Context:

Developed in 1999 before smartphones, had to dial 2580 and receive the song by SMS. Developed into an app and sold to apple in 2018 for $400 Million
Hard Because: brief waveform, heavy ambient noise, reverb, bad microphone - clipping, dropouts, EQ changes.
Compare to millions of songs very quickly, & no false matches: EG waveform fails
Like identifying a person’s speech in a noisy crowd amongst millions of people.
Waveform + Fourier Transform:

Microphone records song as waveform - long list of numbers = air pressure/time
Accurate for sound, difficult to recognise a song from millions of changing numbers.
What matters is the order of musical frequencies - extracted by the Fourier transform click
FT breaks down waveform into sinusoids (sine waves representing frequencies) - analogous: Piggy bank -> coin sorting machine -> each coin type: value and volume
Shazam uses Fast Fourier Transform - same result, more efficient algorithm, how so fast on phone. (reducing complexity from O(N2) to O(NlogN)) 
Short term FT, normal FT represents how much of a certain frequency there is across the entire wavelength, no time differentiation, so lots of short overlapping FTs across wavelength that are tens of milliseconds long to workout when they occur 
Peak Detection + Fingerprints:

Spectrogram: 2D graph where x axis is time, y axis is frequency and brightness is amplitude, shows which frequencies are where - formed by stacking the FFT results of successive windows. 
Spectrogram still contains all other sounds so Shazam sparsifies by isolating strongest peaks (highest amplitude) amongst local frequencies - analogous to removing all pennies from piggy bank earlier and getting similar total. Peaks are more likely to survive distortions e.g. background noise or eq changes; also removes amplitude component - only coordinates matter giving constellation map. 

Matching fingerprint (Hashing + Searching):
From constellation map, Shazam creates fingerprints by pairing peaks
Each peak = an anchor point, paired with other peaks occurring afterwards - in a target zone.
Each pair records the two frequencies of the points and the time difference between them (f₁, f₂, Δt) which is hashed into a fingerprint
Can think of each fingerprint or hash value as a shelf in a library containing multiple books (songs and where each fingerprint occurs in the song)
Shazam can calculate the time offset: offset = time in song - time in recording
When Shazam finds a book on a shelf, it casts a vote for both that song and the time offset. When enough fingerprints cast votes for the same song at the same time offset, Shazam can identify the song and return its information
Demo:

AI + embeddings:

Vector Search:

Conclusion:
