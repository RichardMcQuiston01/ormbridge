package extras.embed;

import jakarta.persistence.AttributeOverride;
import jakarta.persistence.AttributeOverrides;
import jakarta.persistence.Column;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;

@Entity
public class Company {
  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Embedded private Address headquarters;

  // The same embeddable twice: its columns have to be renamed the second time.
  @Embedded
  @AttributeOverrides({
    @AttributeOverride(name = "street", column = @Column(name = "branch_street", length = 60)),
    @AttributeOverride(name = "city", column = @Column(name = "branch_city")),
    @AttributeOverride(name = "geo.lat", column = @Column(name = "branch_lat")),
    @AttributeOverride(name = "geo.lon", column = @Column(name = "branch_lon"))
  })
  private Address branch;

  // An embeddable type needs no @Embedded.
  private Contact contact;
}
