# IMG_1103 Dynamic Layer Result

## Question

Can the supplied roll-end DNG produce a roll-specific length without using the
owner's approximate 147 m figure as calibration?

## Inputs used

- Full-resolution `IMG_1103.DNG`: 8064 x 6048 pixels.
- Manually reviewed roll ellipse and core fraction.
- Tape marks for provisional image scale only.
- No supplied length, GSM or fixed effective thickness.

## Result

The answer from this capture is **inconclusive**. The full-resolution polar
analysis detected a median of 115 candidate boundaries per angular sector, but
the sector count had an interquartile spread of 16.5. The corresponding
diagnostic perimeter sums ranged from 29.6 m to 45.8 m. Parameter variations
also changed the result substantially.

Visual review shows that the detector is following broad folds and fluffy pile
texture. Individual wrap interfaces disappear through large smooth regions of
the roll face. The software therefore withheld a metre estimate rather than
calibrating to, or guessing from, the approximate 147 m report.

## Decision

Do not use this image for a photo-only inventory measurement or a sub-1%
accuracy claim. The test confirms that roll-specific dynamic estimation is the
right requirement, but this particular end-face appearance does not expose the
physical layer spacing needed to solve it reliably.
