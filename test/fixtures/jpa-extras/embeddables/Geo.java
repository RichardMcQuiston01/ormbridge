package extras.embed;

import jakarta.persistence.Embeddable;

@Embeddable
public class Geo {
  private Double lat;
  private Double lon;
}
