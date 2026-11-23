import { useMemo, useState, useEffect } from 'react'
import { supabase } from './supabase'
import {
  CalendarDays, Clock3, MapPin, Menu, ArrowRight,
  CheckCircle2, CreditCard, ChevronLeft, ChevronRight, Trophy,
  Zap, Bell, X, Upload
} from 'lucide-react'

type Court = number
type Slot = { start: number; end: number; label: string }
type BookingSelection = { court: Court; hour: number }

// ==========================================
// NESLI SPORTS CONFIGURATION
// ==========================================

// Number of courts available for booking
const COURT_COUNT = 2
const RECEIPT_BUCKET = 'payment-receipts' // Create this Supabase Storage bucket

// Automatically generates courts based on COURT_COUNT
const courts: Court[] = Array.from(
  { length: COURT_COUNT },
  (_, index) => index + 1
)

const slots: Slot[] = Array.from({ length: 18 }, (_, i) => ({
  start: 5 + i,
  end: 6 + i,
  label: `${formatHour(5 + i)} – ${formatHour(6 + i)}`
}))

function formatHour(hour: number) {
  const h = hour % 24
  const suffix = h >= 12 ? 'PM' : 'AM'
  const display = h % 12 || 12
  return `${display}:00 ${suffix}`
}

function formatCompactHour(hour: number) {
  const h = hour % 24
  const suffix = h >= 12 ? 'pm' : 'am'
  const display = h % 12 || 12
  return `${display}${suffix}`
}

function formatSummaryRanges(bookings: BookingSelection[]) {
  const courtNumbers = [...new Set(bookings.map(b => b.court))].sort((a, b) => a - b)
  return courtNumbers.flatMap(court => {
    const hours = bookings.filter(b => b.court === court).map(b => b.hour).sort((a, b) => a - b)
    const ranges: Array<{ start: number; end: number }> = []
    for (const hour of hours) {
      const last = ranges[ranges.length - 1]
      if (last && hour === last.end) last.end = hour + 1
      else ranges.push({ start: hour, end: hour + 1 })
    }
    return ranges.map(range => {
      const start = formatCompactHour(range.start)
      const end = formatCompactHour(range.end)
      const startSuffix = start.slice(-2).toUpperCase()
      const endSuffix = end.slice(-2).toUpperCase()
      const startTime = start.slice(0, -2)
      const endTime = end.slice(0, -2)
      const rangeText = startSuffix === endSuffix
        ? `${startTime}–${endTime}${endSuffix}`
        : `${start.toUpperCase()}–${end.toUpperCase()}`
      return `Court ${court}: ${rangeText}`
    })
  }).join('; ')
}

function formatBookingRanges(bookings: BookingSelection[]) {
  const courts = [...new Set(bookings.map(b => b.court))].sort((a, b) => a - b)
  return courts.flatMap(court => {
    const hours = bookings.filter(b => b.court === court).map(b => b.hour).sort((a, b) => a - b)
    if (!hours.length) return []
    const ranges: Array<{ start: number; end: number }> = []
    for (const hour of hours) {
      const last = ranges[ranges.length - 1]
      if (last && hour === last.end) last.end = hour + 1
      else ranges.push({ start: hour, end: hour + 1 })
    }
    return ranges.map(range => {
      const start = formatCompactHour(range.start)
      const end = formatCompactHour(range.end)
      const startSuffix = start.slice(-2)
      const endSuffix = end.slice(-2)
      const startTime = start.slice(0, -2)
      const endTime = end.slice(0, -2)
      const rangeText = startSuffix === endSuffix
        ? `${startTime}–${endTime}${endSuffix}`
        : `${start}–${end}`
      return `Court ${court}: ${rangeText}`
    })
  }).join(' | ')
}

function rateFor(hour: number) {
  return hour >= 17 ? 300 : 200
}

// For same-day bookings, allow a slot until 30 minutes after its start time.
// Example: 1:25 PM may still book 1:00-2:00 PM, but 1:31 PM may not.
function isPastBookingCutoff(date: Date, hour: number, now = new Date()) {
  const slotStart = new Date(date)
  slotStart.setHours(hour, 30, 0, 0)
  const selectedDay = localDateISO(date)
  const today = localDateISO(now)
  return selectedDay < today || (selectedDay === today && now >= slotStart)
}

function localDateISO(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateLabel(date: Date) {
  return date.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })
}

function App() {
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [selectedBookings, setSelectedBookings] = useState<BookingSelection[]>([])
  const [step, setStep] = useState(1)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [notice, setNotice] = useState('')
  const [showAdmin, setShowAdmin] = useState(false)
  const [availabilityBookings, setAvailabilityBookings] = useState<any[]>([])
  const [todayBookings, setTodayBookings] = useState<any[]>([])
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [availabilityError, setAvailabilityError] = useState('')
  const [confirmation, setConfirmation] = useState<any>(null)
  const [showReservationGuidelines, setShowReservationGuidelines] = useState(false)

  const total = useMemo(() => selectedBookings.reduce((sum, booking) => sum + rateFor(booking.hour), 0), [selectedBookings])

  // After a successful booking, move the viewport to the confirmation on both desktop and mobile.
  useEffect(() => {
    if (step !== 4 || !confirmation) return
    const timer = window.setTimeout(() => {
      document.getElementById('reservation-confirmation')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [step, confirmation])

  useEffect(() => {
    let cancelled = false
    const date = localDateISO(selectedDate)
    const today = localDateISO(new Date())

    const loadAvailability = async () => {
      setAvailabilityLoading(true)
      setAvailabilityError('')

      const dates = [...new Set([date, today])]
      const results = await Promise.all(
        dates.map(bookingDate =>
          supabase.rpc('get_public_court_availability', {
            p_booking_date: bookingDate
          })
        )
      )

      if (cancelled) return

      const error = results.find(result => result.error)?.error

      if (error) {
        setAvailabilityError(error.message)
        setAvailabilityBookings([])
        setTodayBookings([])
        console.error('Availability RPC error:', error)
      } else {
        const rows = results.flatMap(result => result.data ?? [])
        setAvailabilityBookings(rows.filter(row => row.booking_date === date))
        setTodayBookings(rows.filter(row => row.booking_date === today))
      }

      setAvailabilityLoading(false)
    }

    loadAvailability()

    const channel = supabase
      .channel(`public-booking-availability-${date}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookings' },
        () => loadAvailability()
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [selectedDate])

  const changeDate = (days: number) => {
    const next = new Date(selectedDate)
    next.setDate(next.getDate() + days)
    setSelectedDate(next)
    setSelectedBookings([])
  }

  const isBooked = (court: Court, hour: number) => availabilityBookings.some(booking =>
    booking.court_number === court && booking.start_time?.slice(0, 5) === `${String(hour).padStart(2, '0')}:00`
  )

  const toggleSlot = (court: Court, hour: number) => {
    if (isBooked(court, hour) || isPastBookingCutoff(selectedDate, hour)) return
    setSelectedBookings(prev => {
      const exists = prev.some(item => item.court === court && item.hour === hour)
      return exists ? prev.filter(item => !(item.court === court && item.hour === hour)) : [...prev, { court, hour }].sort((a, b) => a.hour - b.hour || a.court - b.court)
    })
  }

  const submitDemo = async () => {
    if (selectedBookings.some(item => isPastBookingCutoff(selectedDate, item.hour))) {
      setNotice('Some selected time slots are no longer bookable. Please select a future or eligible slot.')
      return
    }

    // Re-check selected slots against Supabase immediately before submission.
    // This protects against stale availability on mobile and desktop.
    const bookingDate = localDateISO(selectedDate)
    const { data: latestBookings, error: availabilityCheckError } =
      await supabase.rpc('get_public_court_availability', {
        p_booking_date: bookingDate
      })

    if (availabilityCheckError) {
      setNotice('Unable to verify availability right now. Please try again.')
      console.error('Availability validation error:', availabilityCheckError)
      return
    }

    const conflicts = selectedBookings.filter(selected =>
      (latestBookings ?? []).some((existing: { court_number: number; start_time: string }) =>
        existing.court_number === selected.court &&
        existing.start_time?.slice(0, 5) === `${String(selected.hour).padStart(2, '0')}:00`
      )
    )

    if (conflicts.length > 0) {
      setAvailabilityBookings(latestBookings ?? [])
      setSelectedBookings(prev => prev.filter(selected =>
        !conflicts.some(conflict => conflict.court === selected.court && conflict.hour === selected.hour)
      ))
      setNotice('One or more selected slots have just been reserved. They have been removed from your selection. Please choose another available slot.')
      return
    }

    if (!name.trim() || phone.length < 10 || selectedBookings.length === 0 || !receipt) {
      setNotice('Please complete your details, select a slot, and upload your payment receipt.')
      return
    }

    setNotice('Submitting booking...')
    try {
      const groupId = crypto.randomUUID()
      const safeName = receipt.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const receiptPath = `${groupId}/${Date.now()}-${safeName}`
      const { error: uploadError } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .upload(receiptPath, receipt, { upsert: false })
      if (uploadError) throw uploadError

      const rows = selectedBookings.map((booking) => ({
        booking_group_id: groupId,
        booking_date: localDateISO(selectedDate),
        court_number: booking.court,
        start_time: `${String(booking.hour).padStart(2, '0')}:00:00`,
        end_time: `${String(booking.hour + 1).padStart(2, '0')}:00:00`,
        booker_name: name.trim(),
        phone_number: phone,
        receipt_path: receiptPath,
        amount_due: rateFor(booking.hour),
        amount_paid: rateFor(booking.hour),
        status: 'pending',
        payment_method: 'online'
      }))

      const { error: insertError } = await supabase.from('bookings').insert(rows)
      if (insertError) {
        await supabase.storage.from(RECEIPT_BUCKET).remove([receiptPath])
        throw insertError
      }

      setConfirmation({
        reference: groupId.slice(0, 8).toUpperCase(),
        name: name.trim(),
        phone,
        date: selectedDate,
        bookings: [...selectedBookings].sort((a, b) => a.hour - b.hour || a.court - b.court),
        total,
        paymentMethod: 'Full payment online (GCash QR)',
      })
      setNotice('')
      setStep(4)
    } catch (error: any) {
      console.error('Booking submission error:', error)
      setNotice(error?.message || 'Could not submit booking. Please try again.')
    }
  }

  return (
    <div className="app-shell">
      <style>{`
        .court-cell.available {
          background: #e8f7ee !important;
          border: 1px solid #b8e4c8 !important;
          color: #166534 !important;
          transition: background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
        }
        .court-cell.available:hover:not(:disabled) {
          background: #d5f1df !important;
          border-color: #86d5a5 !important;
          box-shadow: 0 0 0 2px rgba(34, 160, 90, 0.10);
        }
        .court-cell.available:focus-visible {
          outline: 2px solid #269653;
          outline-offset: 2px;
        }
        .court-cell.selected {
          background: #ffda48 !important;
          border-color: #e8bd0c !important;
          color: #10284b !important;
        }
        .court-cell.booked {
          background: #e2e8f0 !important;
          border-color: #d4dce7 !important;
          color: #64748b !important;
          cursor: not-allowed;
        }
        /* Minor layout adjustments requested */
        .header {
          position: static !important;
          top: auto !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          width: 100% !important;
          box-sizing: border-box !important;
        }
        /* Keep desktop navigation on the right side of the header */
        .header .nav {
          margin-left: auto !important;
          justify-content: flex-end !important;
        }
        .header .brand {
          flex: 0 0 auto !important;
        }
        @media (max-width: 640px) {
          .header {
            justify-content: space-between !important;
            gap: 8px !important;
            position: relative !important;
          }
          .header .brand {
            margin-right: auto !important;
          }
          .header .menu-button {
            position: static !important;
            margin-left: auto !important;
            margin-right: 0 !important;
            flex: 0 0 auto !important;
          }
          .header .nav {
            position: absolute !important;
            left: 0 !important;
            right: 0 !important;
            top: 100% !important;
            width: 100% !important;
            margin: 0 !important;
            z-index: 100 !important;
          }
        }
        /* Uniform white background across all main website sections */
        .app-shell,
        main,
        .rates-section,
        .courts-section,
        .about-section {
          background: #ffffff !important;
        }
        .court-availability-container,
        .court-availability-heading,
        .availability-note {
          background: #ffffff !important;
        }
        /* Requested smaller section heading and compact court availability cards */
        .rates-section .section-heading h2,
        .court-availability-heading h2 {
          font-size: 20px !important;
          line-height: 1.2 !important;
        }
        .court-availability-cards {
          display: grid !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 8px !important;
        }
        .availability-card {
          zoom: 0.9 !important;
          min-width: 0 !important;
        }
        /* Keep rate cards more compact while retaining readable content */
        .rate-cards {
          zoom: 0.8 !important;
        }
        .availability-card-top,
        .availability-card-body,
        .availability-card-footer {
          padding: 10px !important;
        }
        @media (max-width: 640px) {
          .rates-section .section-heading h2 { font-size: 15px !important; }
          .court-availability-heading h2 { font-size: 15px !important; }
          .court-availability-cards { gap: 8px !important; }
          .availability-card { zoom: 0.9 !important; }
          .rate-cards { zoom: 0.8 !important; }
        }
      `}</style>
      <header className="header">
        <a className="brand" href="#home" aria-label="NESLI Sports home">
          <img
            src="/nesli-logo.png"
            alt="NESLI Sports Pickle Court"
            style={{ height: 44, width: "auto", maxWidth: 140, objectFit: "contain", display: "block" }}
          />
        </a>
        <nav className={mobileMenu ? 'nav open' : 'nav'}>
          <a className="active" href="#home" onClick={() => setMobileMenu(false)}>Home</a>
          <a href="#booking" onClick={() => setMobileMenu(false)}>Book a Court</a>
          <a href="#courts" onClick={() => setMobileMenu(false)}>Courts</a>
          <a href="#rates" onClick={() => setMobileMenu(false)}>Rates</a>
          <a href="#about" onClick={() => setMobileMenu(false)}>About</a>
        </nav>
        <button className="menu-button" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Toggle menu">
          {mobileMenu ? <X /> : <Menu />}
        </button>
      </header>

      <main>
        <section className="hero" id="home">
          <div className="hero-photo" />
          <div className="hero-shade" />
          <div className="hero-content">
            <p className="eyebrow">PICKLEBALL AT NESLI SPORTS</p>
            <h1>Book Your<br/><span>Pickleball Court</span> Today</h1>
            <p className="hero-copy">Fast, easy, and hassle-free court reservations.</p>
            <div className="hero-actions">
              <a className="button button-yellow" href="#booking"><CalendarDays size={18}/> Book a Court</a>
              <a className="button button-outline" href="#courts">View Courts</a>
            </div>
          </div>
          <div className="hero-info">
            <div><CalendarDays/><span><strong>Open Daily</strong><small>5:00 AM – 11:00 PM</small></span></div>
            <div><CreditCard/><span><strong>Court Rates</strong><small>5:00 AM – 5:00 PM&nbsp;&nbsp; ₱200/hr<br/>5:00 PM – 11:00 PM&nbsp;&nbsp; ₱300/hr</small></span></div>
          </div>
        </section>

        <section className="benefits">
          <Benefit icon={<CalendarDays/>} title="Real-time Booking" text="See available slots and book instantly."/>
          <Benefit icon={<Zap/>} title="Multiple Courts" text="Book any available court."/>
          <Benefit icon={<CreditCard/>} title="Online Payment" text="Pay your reservation online."/>
          <Benefit icon={<Bell/>} title="Instant Updates" text="Get booking confirmations and updates."/>
        </section>

        <section className="booking-section" id="booking">
          <div className="booking-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow dark">RESERVE YOUR GAME</p>
                <h2>Book a Court</h2>
              </div>
              <div className="stepper">
                {['Select', 'Details', 'Payment', 'Confirm'].map((label, i) => (
                  <div className={`step ${step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''}`} key={label}>
                    <span>{step > i + 1 ? <CheckCircle2 size={15}/> : i + 1}</span>{label}
                  </div>
                ))}
              </div>
            </div>

            <div className="booking-grid">
              <div className="booking-main-stack">
              <div className="date-card date-toolbar">
                <div className="date-card-heading">
                  <h3>Select Date</h3>
                  <span>Choose the day you want to play</span>
                </div>
                <div className="date-controls">
                  <div className="month-nav">
                    <button onClick={() => changeDate(-1)} aria-label="Previous day"><ChevronLeft/></button>
                    <strong>{selectedDate.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</strong>
                    <button onClick={() => changeDate(1)} aria-label="Next day"><ChevronRight/></button>
                  </div>
                  <div className="date-display">
                    <div className="date-big">{selectedDate.getDate()}</div>
                    <div><strong>{selectedDate.toLocaleDateString('en-PH', { weekday: 'long' })}</strong><small>{selectedDate.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</small></div>
                  </div>
                  <button className="today-button" onClick={() => {setSelectedDate(new Date());setSelectedBookings([])}}>Today</button>
                </div>
              </div>

              <div className="slots-card court-table-card">
                <div className="slots-header court-table-header">
                  <h3>Select Court & Time Slots</h3>
                  <div className="legend"><span className="available"/>Available <span className="selected"/>Selected <span className="booked"/>Booked</div>
                </div>
                <div className="court-booking-table-wrap">
                  <table className="court-booking-table">
                    <thead>
                      <tr>
                        <th className="time-column">Time</th>
                        {courts.map(court => <th key={court}>Court {court}<small>Indoor</small></th>)}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="period-row"><td colSpan={courts.length + 1}>Morning</td></tr>
                      {slots.filter(slot => slot.start < 12).map(slot => (
                        <tr key={slot.start}>
                          <td className="time-cell"><span className="time-range"><span>{formatHour(slot.start)} –</span><span>{formatHour(slot.end)}</span></span></td>
                          {courts.map(court => {
                            const booked = availabilityLoading || Boolean(availabilityError) || isBooked(court, slot.start) || isPastBookingCutoff(selectedDate, slot.start)
                            const selected = selectedBookings.some(item => item.court === court && item.hour === slot.start)
                            return <td key={court}><button type="button" disabled={booked} className={`court-cell ${booked ? 'booked' : selected ? 'selected' : 'available'}`} onClick={() => toggleSlot(court, slot.start)}>{booked ? (isPastBookingCutoff(selectedDate, slot.start) ? 'Past' : 'Booked') : selected ? 'Selected' : 'Available'}</button></td>
                          })}
                        </tr>
                      ))}
                      <tr className="period-row"><td colSpan={courts.length + 1}>Afternoon</td></tr>
                      {slots.filter(slot => slot.start >= 12 && slot.start < 17).map(slot => (
                        <tr key={slot.start}>
                          <td className="time-cell"><span className="time-range"><span>{formatHour(slot.start)} –</span><span>{formatHour(slot.end)}</span></span></td>
                          {courts.map(court => {
                            const booked = availabilityLoading || Boolean(availabilityError) || isBooked(court, slot.start) || isPastBookingCutoff(selectedDate, slot.start)
                            const selected = selectedBookings.some(item => item.court === court && item.hour === slot.start)
                            return <td key={court}><button type="button" disabled={booked} className={`court-cell ${booked ? 'booked' : selected ? 'selected' : 'available'}`} onClick={() => toggleSlot(court, slot.start)}>{booked ? (isPastBookingCutoff(selectedDate, slot.start) ? 'Past' : 'Booked') : selected ? 'Selected' : 'Available'}</button></td>
                          })}
                        </tr>
                      ))}
                      <tr className="period-row"><td colSpan={courts.length + 1}>Evening</td></tr>
                      {slots.filter(slot => slot.start >= 17).map(slot => (
                        <tr key={slot.start}>
                          <td className="time-cell"><span className="time-range"><span>{formatHour(slot.start)} –</span><span>{formatHour(slot.end)}</span></span></td>
                          {courts.map(court => {
                            const booked = availabilityLoading || Boolean(availabilityError) || isBooked(court, slot.start) || isPastBookingCutoff(selectedDate, slot.start)
                            const selected = selectedBookings.some(item => item.court === court && item.hour === slot.start)
                            return <td key={court}><button type="button" disabled={booked} className={`court-cell ${booked ? 'booked' : selected ? 'selected' : 'available'}`} onClick={() => toggleSlot(court, slot.start)}>{booked ? (isPastBookingCutoff(selectedDate, slot.start) ? 'Past' : 'Booked') : selected ? 'Selected' : 'Available'}</button></td>
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {availabilityLoading && <p className="availability-loading">Loading live availability…</p>}
                {availabilityError && <p className="availability-error">Unable to load availability: {availabilityError}</p>}
              </div>
              </div>

              <aside className="summary-card">
                <h3>Booking Summary</h3>
                <div className="summary-row"><CalendarDays size={17}/><span>{dateLabel(selectedDate)}</span></div>
                <div className="summary-row"><MapPin size={17}/><span>{selectedBookings.length ? [...new Set(selectedBookings.map(item => item.court))].map(court => `Court ${court}`).join(', ') : 'Select court'}</span></div>
                <div className="summary-row summary-bookings"><Clock3 size={17}/><span>{selectedBookings.length ? formatSummaryRanges(selectedBookings) : 'Select time slots'}</span></div>
                <div className="summary-row"><CreditCard size={17}/><span>{selectedBookings.length ? `₱${total.toLocaleString()} court fee` : 'Rate: ₱200 / ₱300 per hour'}</span></div>
                <button className="button button-blue full" disabled={!selectedBookings.length} onClick={() => setShowReservationGuidelines(true)}>Continue to Details <ArrowRight size={16}/></button>
              </aside>
            </div>

            {showReservationGuidelines && (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="reservation-guidelines-title"
                style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(10, 24, 48, .58)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
              >
                <div style={{ width: 'min(520px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: '#fff', color: '#10284b', borderRadius: 18, padding: 24, boxShadow: '0 25px 70px rgba(0,0,0,.25)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <p className="eyebrow dark" style={{ margin: '0 0 6px' }}>NESLI SPORTS</p>
                      <h2 id="reservation-guidelines-title" style={{ margin: 0, fontSize: 24 }}>Reservation Guidelines</h2>
                    </div>
                    <button type="button" className="icon-button" aria-label="Close guidelines" onClick={() => setShowReservationGuidelines(false)}><X size={20}/></button>
                  </div>
                  <ul style={{ paddingLeft: 22, margin: '18px 0', display: 'grid', gap: 12, lineHeight: 1.55 }}>
                    <li>Reservations are noted and provisionally recorded upon request.</li>
                    <li>Full payment must be made at least <strong>72 hours before</strong> your scheduled booking to secure your reservation.</li>
                    <li>Failure to pay within the specified period may result in cancellation of your provisional reservation, and the court may be made available to other players.</li>
                    <li>Reservations are confirmed only once payment has been received and verified.</li>
                  </ul>
                  <p style={{ margin: '0 0 20px', color: '#64748b', fontSize: 14 }}>Please confirm that you have read and understood these guidelines before proceeding.</p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <button type="button" className="button button-blue" style={{ flex: '1 1 180px' }} onClick={() => { setShowReservationGuidelines(false); setStep(2); window.setTimeout(() => document.getElementById('player-details')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100) }}>I Agree & Continue <ArrowRight size={16}/></button>
                    <button type="button" className="button button-outline" onClick={() => setShowReservationGuidelines(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {step === 4 && confirmation ? (
              <>
                <style>{confirmationStyles}</style>
                <div className="details-panel reservation-confirmation" id="reservation-confirmation">
                <div className="confirmation-header">
                  <div className="confirmation-success-icon"><CheckCircle2 size={28}/></div>
                  <div><p className="eyebrow dark">NESLI SPORTS</p><h2>Reservation Request Received</h2><p className="confirmation-subtitle">Awaiting admin confirmation.</p></div>
                </div>
                <div className="confirmation-reference"><small>BOOKING REFERENCE</small><strong>{confirmation.reference}</strong><span className="confirmation-status">PENDING ADMIN CONFIRMATION</span></div>
                <div className="confirmation-grid">
                  <div><small>Customer</small><strong>{confirmation.name}</strong></div>
                  <div><small>Mobile Number</small><strong>{confirmation.phone}</strong></div>
                  <div><small>Play Date</small><strong>{confirmation.date.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong></div>
                  <div><small>Booked Courts & Times</small><strong>{formatBookingRanges(confirmation.bookings)}</strong></div>
                  <div><small>Rent Total</small><strong>₱{confirmation.total.toLocaleString()}</strong></div>
                  <div><small>Payment Option</small><strong>{confirmation.paymentMethod}</strong></div>
                  
                  <div className="confirmation-payment-status"><small>Payment Status</small><strong>Awaiting receipt verification</strong></div>
                </div>
                <div className="confirmation-policy"><strong>Important</strong><p>Keep your booking reference. Reservation is pending admin confirmation and payment receipt verification.</p></div>
                <p className="confirmation-footnote">Request receipt only—not final approval.</p>
                <button className="button button-blue" onClick={() => { setStep(1); setSelectedBookings([]); setName(''); setPhone(''); setReceipt(null); setConfirmation(null); setNotice(''); window.scrollTo({ top: document.getElementById('booking')?.offsetTop ?? 0, behavior: 'smooth' }) }}>Close Confirmation</button>
                </div>
              </>
            ) : step >= 2 && (
              <div className="details-panel" id="player-details">
                <div className="details-heading"><h3>Player Details</h3><button className="icon-button" onClick={() => setStep(1)}><X size={18}/></button></div>
                <div className="form-grid">
                  <label>Full Name<input value={name} onChange={e => setName(e.target.value)} placeholder="Enter your full name"/></label>
                  <label>Mobile Number<input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))} placeholder="09XXXXXXXXX" inputMode="numeric"/></label>
                </div>
                <div className="payment-box">
                  <div className="payment-title"><CreditCard/><div><strong>Online Payment</strong><small>Upload your GCash payment receipt</small></div></div>
                  <div className="qr-payment">
  <p className="qr-instructions">
    Scan the QR code below to pay your reservation fee.
  </p>

  <img
    src="/gcash-qr.png"
    alt="NESLI Sports GCash payment QR code"
    className="payment-qr-image"
  />

  <p className="qr-caption">
    Please upload your payment receipt after completing the transaction.
  </p>
</div>
                  <label className="upload-receipt"><Upload size={18}/>{receipt ? receipt.name : 'Upload payment receipt'}<input type="file" accept="image/*,.pdf" onChange={e => setReceipt(e.target.files?.[0] ?? null)}/></label>
                </div>
                <button className="button button-yellow full" onClick={submitDemo}>Submit Booking <ArrowRight size={17}/></button>
                {notice && <div className="notice"><CheckCircle2 size={18}/>{notice}</div>}
              </div>
            )}
          </div>

        </section>

        <section className="rates-section" id="rates">
          <div className="section-heading"><div><h2>Court Rates</h2></div></div>
          <div className="rate-cards">
            <div className="rate-card"><div className="rate-icon"><SunIcon/></div><p>DAYTIME</p><h3>₱200<span>/hour</span></h3><small>5:00 AM – 5:00 PM</small></div>
            <div className="rate-card evening"><div className="rate-icon"><Clock3/></div><p>EVENING</p><h3>₱300<span>/hour</span></h3><small>5:00 PM – 11:00 PM</small></div>
          </div>
        </section>

        <section className="courts-section" id="courts">
          <div className="court-availability-container">
            <div className="court-availability-heading">
              <p className="eyebrow dark">CHECK AVAILABILITY</p>
              <h2>Court Availability Today</h2>
              <p className="availability-date">
                {new Date().toLocaleDateString('en-PH', {
                  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
                })}
              </p>
            </div>

            <div className="court-availability-cards">
              {courts.map(court => {
                const bookedSlots = todayBookings.filter(b => b.court_number === court).map(b => Number(b.start_time.slice(0, 2)))
                const slotsLeft = slots.filter(slot => {
                  const hour = slot.start
                  return !bookedSlots.includes(hour) && !isPastBookingCutoff(new Date(), hour)
                }).length
                const availability = (slotsLeft / slots.length) * 100

                return (
                  <article className="availability-card" key={court}>
                    <div className="availability-card-top">
                      <div className="court-icon"><span>🏓</span></div>
                      <div className="court-number-label">
                        <span>COURT</span>
                        <h3>Court {court}</h3>
                      </div>
                      <span className="availability-status">
                        <span className="status-dot" /> {availabilityLoading ? 'Loading' : availabilityError ? 'Unavailable' : slotsLeft > 0 ? 'Available' : 'Fully booked'}
                      </span>
                    </div>

                    <div className="availability-card-body">
                      <div className="slots-info">
                        <div>
                          <strong>{slotsLeft}</strong>
                          <span>Slots Available</span>
                        </div>
                        <div className="slots-total">
                          <strong>{bookedSlots.length}</strong>
                          <span>Booked</span>
                        </div>
                      </div>
                      <div className="availability-progress">
                        <div className="availability-progress-fill" style={{ width: `${availability}%` }} />
                      </div>
                      <div className="availability-card-footer">
                        <span><Clock3 size={15} /> 5:00 AM – 11:00 PM</span>
                        <a href="#booking" onClick={() => { setSelectedBookings([]); setSelectedDate(new Date()) }}>
                          Book this court <ArrowRight size={16} />
                        </a>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="availability-note">
              <CheckCircle2 size={17} />
              <span>Choose a time slot in the booking table to reserve your game.</span>
            </div>
          </div>
        </section>

        <section className="about-section" id="about">
          <div className="about-icon"><Trophy size={30}/></div>
          <div className="about-content">
            <p className="eyebrow">NESLI SPORTS</p>
            <h2>Bring your game. We'll take care of the court.</h2>
            <p>Book your next match with friends, family, or your pickleball community.</p>
            <div className="about-links" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 18 }}>
              <a href="https://www.facebook.com/NesliSports" target="_blank" rel="noopener noreferrer" className="button button-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#ffffff', color: '#12305a', border: '1px solid #cbd8e8', fontWeight: 700 }}>
                <span aria-hidden="true" style={{ fontWeight: 800 }}>f</span> Facebook Page <ArrowRight size={16}/>
              </a>
              <a href="https://www.google.com/maps/place/Nesli+Sports/@8.5484609,125.9337051,17z/data=!3m1!4b1!4m6!3m5!1s0x32fdfd006ef505e3:0x42b52b0225ca4da5!8m2!3d8.5484609!4d125.93628!16s%2Fg%2F11zyvlksv2?entry=ttu&g_ep=EgoyMDI2MTExNy4wIKXMDSoASAFQAw%3D%3D" target="_blank" rel="noopener noreferrer" className="button button-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#ffffff', color: '#12305a', border: '1px solid #cbd8e8', fontWeight: 700 }}>
                <MapPin size={16}/> View Location <ArrowRight size={16}/>
              </a>
            </div>
          </div>
          <a className="button button-yellow" href="#booking">Reserve Now <ArrowRight/></a>
        </section>
      </main>

      <footer><div className="brand footer-brand"><img src="/nesli-logo.png" alt="NESLI Sports" style={{ height: 30, width: "auto", maxWidth: 110, objectFit: "contain", display: "block" }} /></div><p>© {new Date().getFullYear()} NESLI Sports. All rights reserved.</p><p>Pickleball · Community · Competition</p></footer>
      {showAdmin && <AdminPortal onClose={() => setShowAdmin(false)} />}
    </div>
  )
}

function Benefit({ icon, title, text }: {icon: React.ReactNode; title: string; text: string}) {
  return <div className="benefit"><div className="benefit-icon">{icon}</div><div><strong>{title}</strong><p>{text}</p></div></div>
}

function SunIcon() {
  return <span className="sun-symbol">☀</span>
}


type AdminBooking = {
  id: string
  booking_group_id: string | null
  booking_date: string
  court_number: number
  start_time: string
  end_time: string
  booker_name: string
  phone_number: string | null
  receipt_path: string | null
  amount_due: number
  amount_paid: number
  status: string
  admin_notes: string | null
  created_at: string
}

const confirmationStyles = `
#reservation-confirmation {
  scroll-margin-top: 16px;
  width: 100%;
  box-sizing: border-box;
  padding: clamp(18px, 3vw, 32px);
  margin: 20px 0;
  background: #fff;
  border: 1px solid #dbe4ef;
  border-radius: 20px;
  box-shadow: 0 16px 40px rgba(16, 40, 75, .09);
  color: #10284b;
}
#reservation-confirmation .confirmation-header {
  display: flex; gap: 16px; align-items: flex-start; margin-bottom: 22px;
}
#reservation-confirmation .confirmation-success-icon {
  width: 52px; height: 52px; flex: 0 0 52px; border-radius: 16px;
  background: #e8f7ee; color: #16834b; display: flex; align-items: center; justify-content: center;
}
#reservation-confirmation .confirmation-header .eyebrow {
  margin: 0 0 5px; color: #f97316; font-size: 11px; font-weight: 800; letter-spacing: 1.2px;
}
#reservation-confirmation .confirmation-header h2 {
  margin: 0 0 8px; font-size: clamp(22px, 3vw, 30px); line-height: 1.2; color: #10284b;
}
#reservation-confirmation .confirmation-subtitle { margin: 0; color: #64748b; line-height: 1.55; max-width: 700px; }
#reservation-confirmation .confirmation-reference {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 22px 16px; margin: 0 0 20px; text-align: center;
  background: linear-gradient(135deg, #fff7ed, #fff); border: 1px dashed #fdba74; border-radius: 16px;
}
#reservation-confirmation .confirmation-reference small { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
#reservation-confirmation .confirmation-reference strong { color: #10284b; font-size: clamp(24px, 4vw, 32px); letter-spacing: 2px; }
#reservation-confirmation .confirmation-status {
  display: inline-flex; align-items: center; border-radius: 999px; padding: 7px 12px;
  background: #fff0c2; color: #925500; font-size: 11px; font-weight: 800; letter-spacing: .4px;
}
#reservation-confirmation .confirmation-grid {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0 0 20px;
}
#reservation-confirmation .confirmation-grid > div {
  display: flex; flex-direction: column; gap: 7px; min-width: 0;
  padding: 15px; border: 1px solid #e2e8f0; border-radius: 13px; background: #fff;
}
#reservation-confirmation .confirmation-grid small { color: #64748b; font-size: 12px; }
#reservation-confirmation .confirmation-grid strong { color: #24364f; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
#reservation-confirmation .confirmation-grid > div:nth-child(5),
#reservation-confirmation .confirmation-grid > div:nth-child(7) { background: #f8fafc; }
#reservation-confirmation .confirmation-policy {
  padding: 16px; margin: 0 0 12px; border: 1px solid #fed7aa; border-radius: 13px;
  background: #fff7ed; color: #334155;
}
#reservation-confirmation .confirmation-policy strong { color: #9a3412; }
#reservation-confirmation .confirmation-policy p { margin: 6px 0 0; line-height: 1.55; }
#reservation-confirmation .confirmation-footnote { color: #64748b; font-size: 12px; line-height: 1.5; margin: 0 0 18px; }
#reservation-confirmation > button { min-height: 44px; padding: 11px 20px; border-radius: 10px; font-weight: 700; }
@media(max-width:640px) {
  #reservation-confirmation { padding: 10px; border-radius: 12px; margin: 8px 0; box-shadow: none; }
  #reservation-confirmation .confirmation-header { gap: 8px; margin-bottom: 8px; align-items: center; }
  #reservation-confirmation .confirmation-success-icon { width: 32px; height: 32px; flex-basis: 32px; border-radius: 9px; }
  #reservation-confirmation .confirmation-success-icon svg { width: 20px; height: 20px; }
  #reservation-confirmation .confirmation-header .eyebrow { display: none; }
  #reservation-confirmation .confirmation-header h2 { font-size: 18px; line-height: 1.15; margin: 0 0 2px; }
  #reservation-confirmation .confirmation-subtitle { font-size: 11px; line-height: 1.25; }
  #reservation-confirmation .confirmation-reference { gap: 3px; padding: 7px 8px; margin-bottom: 7px; border-radius: 9px; }
  #reservation-confirmation .confirmation-reference small { font-size: 9px; letter-spacing: .6px; }
  #reservation-confirmation .confirmation-reference strong { font-size: 20px; letter-spacing: 1px; }
  #reservation-confirmation .confirmation-status { padding: 4px 7px; font-size: 9px; letter-spacing: 0; }
  #reservation-confirmation .confirmation-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-bottom: 7px; }
  #reservation-confirmation .confirmation-grid > div { gap: 2px; padding: 6px 7px; border-radius: 7px; }
  #reservation-confirmation .confirmation-grid small { font-size: 9px; line-height: 1.1; }
  #reservation-confirmation .confirmation-grid strong { font-size: 11px; line-height: 1.25; }
  #reservation-confirmation .confirmation-grid > div:nth-child(4),
  #reservation-confirmation .confirmation-grid > div:nth-child(8) { grid-column: 1 / -1; }
  #reservation-confirmation .confirmation-policy { padding: 7px 8px; margin-bottom: 5px; border-radius: 7px; font-size: 10px; line-height: 1.25; }
  #reservation-confirmation .confirmation-policy p { margin-top: 2px; line-height: 1.25; }
  #reservation-confirmation .confirmation-footnote { font-size: 9px; line-height: 1.2; margin: 0 0 7px; }
  #reservation-confirmation > button { min-height: 34px; padding: 7px 12px; border-radius: 7px; font-size: 11px; width: 100%; }
}
`

function AdminPortal({ onClose }: { onClose: () => void }) {
  const [session, setSession] = useState<any>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'dashboard' | 'pending' | 'courtview'>('dashboard')
  const [bookings, setBookings] = useState<AdminBooking[]>([])
  const [courtDate, setCourtDate] = useState(new Date().toISOString().slice(0, 10))
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({})
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>({})
  const [notesInputs, setNotesInputs] = useState<Record<string, string>>({})
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
  }, [])

  useEffect(() => {
    if (session?.user?.email) checkAdmin(session.user.email)
  }, [session])

  const checkAdmin = async (userEmail: string) => {
    const { data, error: checkError } = await supabase
      .from('admin_users')
      .select('email')
      .eq('email', userEmail)
      .maybeSingle()
    if (checkError) {
      setError(checkError.message)
      setAuthorized(false)
      return
    }
    setAuthorized(!!data)
    if (!data) setError('This account is not listed in admin_users.')
  }

  const loadBookings = async () => {
    setLoading(true)
    setError('')
    const { data, error: queryError } = await supabase
      .from('bookings')
      .select('*')
      .order('booking_date', { ascending: false })
      .order('start_time', { ascending: true })
    if (queryError) {
      setError(queryError.message)
      setLoading(false)
      return
    }
    const list = (data || []) as AdminBooking[]
    setBookings(list)
    const initialAmounts: Record<string, string> = {}
    const initialNotes: Record<string, string> = {}
    const urls: Record<string, string> = {}
    for (const booking of list) {
      initialAmounts[booking.id] = String(booking.amount_paid ?? 0)
      initialNotes[booking.id] = booking.admin_notes ?? ''
      if (booking.receipt_path) {
        const { data: signed } = await supabase.storage
          .from(RECEIPT_BUCKET)
          .createSignedUrl(booking.receipt_path, 60 * 60)
        if (signed?.signedUrl) urls[booking.id] = signed.signedUrl
      }
    }
    setAmountInputs(initialAmounts)
    setNotesInputs(initialNotes)
    setReceiptUrls(urls)
    setLoading(false)
  }

  useEffect(() => {
    if (authorized) loadBookings()
  }, [authorized])

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email, password })
    if (loginError) {
      setError(loginError.message)
      setLoading(false)
      return
    }
    setSession(data.session)
    setLoading(false)
  }

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordMessage('')
    if (newPassword.length < 6) {
      setPasswordMessage('Password must be at least 6 characters long.')
      return
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordMessage('The passwords do not match.')
      return
    }
    setPasswordLoading(true)
    const { error: passwordError } = await supabase.auth.updateUser({ password: newPassword })
    setPasswordLoading(false)
    if (passwordError) {
      setPasswordMessage(passwordError.message)
      return
    }
    setPasswordMessage('Password changed successfully.')
    setNewPassword('')
    setConfirmNewPassword('')
  }

  const logout = async () => {
    await supabase.auth.signOut()
    setSession(null)
    setAuthorized(false)
    setBookings([])
  }

  const logStatus = async (booking: AdminBooking, status: string, notes?: string) => {
    const { error: updateError } = await supabase.from('bookings').update({
      status,
      verified_by: session.user.id,
      verified_at: new Date().toISOString(),
      admin_notes: notes ?? booking.admin_notes
    }).eq('id', booking.id)
    if (updateError) throw updateError
    const { error: logError } = await supabase.from('booking_status_logs').insert({
      booking_id: booking.id,
      previous_status: booking.status,
      new_status: status,
      changed_by: session.user.id,
      notes: notes ?? null
    })
    if (logError) console.warn('Status updated but log insert failed:', logError.message)
  }

  const confirmBooking = async (booking: AdminBooking) => {
    try {
      const amount = Number(amountInputs[booking.id])
      if (!Number.isFinite(amount) || amount < 0) {
        setError('Enter a valid amount paid.')
        return
      }
      const { error: amountError } = await supabase.from('bookings').update({
        amount_paid: amount,
        admin_notes: notesInputs[booking.id] || null
      }).eq('id', booking.id)
      if (amountError) throw amountError
      if (amount !== Number(booking.amount_paid)) {
        const { error: logError } = await supabase.from('payment_adjustment_logs').insert({
          booking_id: booking.id,
          previous_amount: Number(booking.amount_paid),
          new_amount: amount,
          adjusted_by: session.user.id,
          reason: notesInputs[booking.id] || 'Amount adjusted during receipt verification'
        })
        if (logError) console.warn('Amount saved but adjustment log failed:', logError.message)
      }
      await logStatus(booking, 'confirmed', notesInputs[booking.id])
      await loadBookings()
    } catch (e: any) {
      setError(e?.message || 'Unable to confirm booking.')
    }
  }

  const rejectBooking = async (booking: AdminBooking) => {
    try {
      await logStatus(booking, 'rejected', notesInputs[booking.id] || 'Receipt rejected')
      await loadBookings()
    } catch (e: any) {
      setError(e?.message || 'Unable to reject booking.')
    }
  }

  const pending = bookings.filter(b => b.status === 'pending')
  const confirmed = bookings.filter(b => b.status === 'confirmed')
  const today = new Date().toISOString().slice(0, 10)
  const todays = bookings.filter(b => b.booking_date === today && b.status === 'confirmed')

  const formatTime = (time: string) => {
    const [h] = time.split(':').map(Number)
    return formatHour(h)
  }

  const adminStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(10,24,48,.58)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16
  }
  const panelStyle: React.CSSProperties = {
    background: '#f8fafc', color: '#10284b', width: 'min(1200px, 100%)', maxHeight: '92vh',
    overflow: 'auto', borderRadius: 18, boxShadow: '0 25px 70px rgba(0,0,0,.25)', padding: 24
  }

  if (!session || !authorized) {
    return <div style={adminStyle}><div style={{ ...panelStyle, maxWidth: 440 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Admin Login</h2><button onClick={onClose}>✕</button>
      </div>
      <p style={{ color: '#64748b' }}>Sign in with your authorized admin account.</p>
      <form onSubmit={login} style={{ display: 'grid', gap: 12 }}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Admin email" required style={{ padding: 12, border: '1px solid #cbd5e1', borderRadius: 8 }} />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required style={{ padding: 12, border: '1px solid #cbd5e1', borderRadius: 8 }} />
        <button type="submit" disabled={loading} style={{ padding: 12, background: '#ffca1a', border: 0, borderRadius: 8, fontWeight: 700 }}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {error && <p style={{ color: '#b91c1c' }}>{error}</p>}
      {session && !authorized && <button onClick={logout} style={{ marginTop: 10 }}>Sign out</button>}
    </div></div>
  }

  return <div style={adminStyle}><div style={panelStyle}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div><p style={{ margin: 0, color: '#2563eb', fontWeight: 800, fontSize: 12, letterSpacing: 1 }}>NESLI SPORTS</p><h2 style={{ margin: '4px 0' }}>Admin Dashboard</h2><small>{session.user.email}</small></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button onClick={loadBookings}>Refresh</button><button onClick={() => { setShowChangePassword(true); setPasswordMessage(''); setNewPassword(''); setConfirmNewPassword('') }}>Change Password</button><button onClick={logout}>Sign out</button><button onClick={onClose}>Close</button></div>
    </header>
    {error && <p style={{ color: '#b91c1c', background: '#fee2e2', padding: 10, borderRadius: 8 }}>{error}</p>}
    {showChangePassword && <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(10,24,48,.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'white', color: '#10284b', width: 'min(420px, 100%)', padding: 24, borderRadius: 16, boxShadow: '0 25px 70px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><h3 style={{ margin: 0 }}>Change Password</h3><button type="button" onClick={() => setShowChangePassword(false)}>✕</button></div>
        <p style={{ color: '#64748b', fontSize: 14 }}>Enter and confirm your new admin password.</p>
        <form onSubmit={changePassword} style={{ display: 'grid', gap: 12 }}>
          <input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="New password (minimum 6 characters)" required minLength={6} style={{ padding: 12, border: '1px solid #cbd5e1', borderRadius: 8, width: '100%', boxSizing: 'border-box' }} />
          <input type="password" autoComplete="new-password" value={confirmNewPassword} onChange={e => setConfirmNewPassword(e.target.value)} placeholder="Confirm new password" required minLength={6} style={{ padding: 12, border: '1px solid #cbd5e1', borderRadius: 8, width: '100%', boxSizing: 'border-box' }} />
          {passwordMessage && <p style={{ margin: 0, color: passwordMessage === 'Password changed successfully.' ? '#047857' : '#b91c1c' }}>{passwordMessage}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button type="button" onClick={() => setShowChangePassword(false)} style={{ padding: '10px 14px' }}>Cancel</button><button type="submit" disabled={passwordLoading} style={{ padding: '10px 14px', background: '#ffca1a', border: 0, borderRadius: 8, fontWeight: 700 }}>{passwordLoading ? 'Updating…' : 'Update Password'}</button></div>
        </form>
      </div>
    </div>}
    <nav style={{ display: 'flex', gap: 8, margin: '20px 0', flexWrap: 'wrap' }}>
      {(['dashboard', 'pending', 'courtview'] as const).map(t => <button key={t} onClick={() => setTab(t)} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', background: tab === t ? '#112b50' : 'white', color: tab === t ? 'white' : '#112b50', fontWeight: 700 }}>{t === 'dashboard' ? 'Dashboard' : t === 'pending' ? `Pending Verification (${pending.length})` : 'Court View'}</button>)}
    </nav>
    {loading && <p>Loading bookings…</p>}
    {tab === 'dashboard' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
      {[['Pending Verification', pending.length, 'Receipts awaiting review', '#f59e0b'], ['Confirmed Bookings', confirmed.length, 'Approved reservations', '#059669'], ["Today's Bookings", todays.length, 'Confirmed bookings today', '#2563eb']].map(([label, value, desc, color]) => <article key={String(label)} style={{ border: '1px solid #dbe2ea', borderRadius: 12, padding: 18, background: 'white' }}><p style={{ margin: 0, color: '#64748b' }}>{label}</p><h2 style={{ margin: '8px 0', color: String(color) }}>{value}</h2><small>{desc}</small></article>)}
    </div>}
    {tab === 'pending' && <div style={{ display: 'grid', gap: 14 }}>
      {pending.length === 0 && <p>No pending receipts to verify.</p>}
      {pending.map(b => <article key={b.id} style={{ background: 'white', border: '1px solid #dbe2ea', borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}><div><h3 style={{ margin: '0 0 6px' }}>{b.booker_name}</h3><p style={{ margin: 0 }}>{b.booking_date} · Court {b.court_number} · {formatTime(b.start_time)}–{formatTime(b.end_time)}</p><small>{b.phone_number || 'No phone'} · Booking ID: {b.id}</small></div><strong style={{ color: '#d97706' }}>Pending Verification</strong></div>
        {receiptUrls[b.id] ? <a href={receiptUrls[b.id]} target="_blank" rel="noreferrer"><img src={receiptUrls[b.id]} alt="Payment receipt" style={{ maxWidth: 260, maxHeight: 300, objectFit: 'contain', marginTop: 12, border: '1px solid #e2e8f0', borderRadius: 8 }} /></a> : <p style={{ color: '#64748b' }}>Receipt unavailable or file is PDF. {b.receipt_path && <a href={receiptUrls[b.id]} target="_blank" rel="noreferrer">Open receipt</a>}</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginTop: 12 }}>
          <label>Amount Due<input value={b.amount_due} readOnly style={{ width: '100%', padding: 10, marginTop: 4, border: '1px solid #cbd5e1', borderRadius: 8 }} /></label>
          <label>Amount Paid (editable)<input type="number" min="0" step="0.01" value={amountInputs[b.id] ?? b.amount_paid} onChange={e => setAmountInputs(prev => ({ ...prev, [b.id]: e.target.value }))} style={{ width: '100%', padding: 10, marginTop: 4, border: '1px solid #cbd5e1', borderRadius: 8 }} /></label>
        </div>
        <label style={{ display: 'block', marginTop: 10 }}>Admin Notes<input value={notesInputs[b.id] ?? ''} onChange={e => setNotesInputs(prev => ({ ...prev, [b.id]: e.target.value }))} placeholder="Optional notes / payment adjustment reason" style={{ width: '100%', padding: 10, marginTop: 4, border: '1px solid #cbd5e1', borderRadius: 8 }} /></label>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}><button onClick={() => confirmBooking(b)} style={{ background: '#059669', color: 'white', border: 0, borderRadius: 8, padding: '10px 16px', fontWeight: 700 }}>Confirm Booking</button><button onClick={() => rejectBooking(b)} style={{ background: '#dc2626', color: 'white', border: 0, borderRadius: 8, padding: '10px 16px', fontWeight: 700 }}>Reject Receipt</button></div>
      </article>)}
    </div>}
    {tab === 'courtview' && <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>Court schedule date <input type="date" value={courtDate} onChange={e => setCourtDate(e.target.value)} /></label>
      <div style={{ overflowX: 'auto', background: 'white', border: '1px solid #dbe2ea', borderRadius: 10 }}>
        <table style={{ borderCollapse: 'collapse', minWidth: 650, width: '100%' }}>
          <thead><tr><th style={{ padding: 10, textAlign: 'left', background: '#e2e8f0' }}>Time</th>{courts.map(c => <th key={c} style={{ padding: 10, background: '#e2e8f0' }}>Court {c}</th>)}</tr></thead>
          <tbody>{slots.map(slot => <tr key={slot.start}><td style={{ padding: 8, border: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>{slot.label}</td>{courts.map(c => {
            const booking = bookings.find(b => b.booking_date === courtDate && b.court_number === c && b.start_time.slice(0, 5) === `${String(slot.start).padStart(2, '0')}:00` && ['pending', 'confirmed'].includes(b.status))
            return <td key={c} style={{ padding: 6, border: '1px solid #e2e8f0', minWidth: 150 }}><div style={{ borderRadius: 8, padding: 10, background: booking ? (booking.status === 'confirmed' ? '#e2e8f0' : '#fef3c7') : '#ecfdf5', textAlign: 'center', fontSize: 13 }}>{booking ? <><strong>{booking.booker_name}</strong><br/><small>{booking.status.toUpperCase()}</small></> : 'Open'}</div></td>
          })}</tr>)}</tbody>
        </table>
      </div>
    </div>}
  </div></div>
}

export default App