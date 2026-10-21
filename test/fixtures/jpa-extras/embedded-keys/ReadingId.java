package extras.embeddedkeys;

import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.time.LocalDate;
import java.util.Objects;

// Hand-written key class without column annotations: the entity renames the columns with @AttributeOverride.
@Embeddable
public class ReadingId implements Serializable {
  private static final long serialVersionUID = 1L;

  private String sensor;
  private LocalDate takenOn;

  public ReadingId() {}

  public String getSensor() {
    return sensor;
  }

  public void setSensor(String sensor) {
    this.sensor = sensor;
  }

  public LocalDate getTakenOn() {
    return takenOn;
  }

  public void setTakenOn(LocalDate takenOn) {
    this.takenOn = takenOn;
  }

  @Override
  public boolean equals(Object other) {
    if (!(other instanceof ReadingId)) {
      return false;
    }
    ReadingId that = (ReadingId) other;
    return Objects.equals(sensor, that.sensor) && Objects.equals(takenOn, that.takenOn);
  }

  @Override
  public int hashCode() {
    return Objects.hash(sensor, takenOn);
  }
}
