package extras.embeddedkeys;

import jakarta.persistence.AttributeOverride;
import jakarta.persistence.AttributeOverrides;
import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.math.BigDecimal;

@Entity
@Table(name = "readings")
public class Reading {
  @EmbeddedId
  @AttributeOverrides({
    @AttributeOverride(name = "sensor", column = @Column(name = "sensor_code", length = 12)),
    @AttributeOverride(name = "takenOn", column = @Column(name = "taken_on"))
  })
  private ReadingId id;

  @Column(name = "reading_value", precision = 8, scale = 2)
  private BigDecimal value;

  public ReadingId getId() {
    return id;
  }

  public BigDecimal getValue() {
    return value;
  }
}
