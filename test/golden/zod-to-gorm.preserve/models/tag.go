package models

// Tag maps to the "Tag" table.
type Tag struct {
	ID    int32  `gorm:"primaryKey;autoIncrement:false"`
	Label string `gorm:"size:50;not null"`
}

// TableName overrides GORM's default table name (tags).
func (Tag) TableName() string {
	return "Tag"
}
