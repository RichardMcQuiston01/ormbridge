//go:build ignore

// dump-gorm-schema prints, as JSON, how GORM itself reads the fixture models:
// table names, column names, keys, indexes, foreign-key constraints and join
// tables. test/gorm-verify.test.ts copies this file and the fixtures into a
// temporary Go module and compares the output with the parser's result.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"sync"

	"fixture/models"
	"fixture/shop"

	"gorm.io/gorm/schema"
)

type columnInfo struct {
	Name       string `json:"name"`
	DBName     string `json:"dbName"`
	PrimaryKey bool   `json:"primaryKey"`
	Unique     bool   `json:"unique"`
	Size       int    `json:"size"`
}

type indexInfo struct {
	Name   string   `json:"name"`
	Unique bool     `json:"unique"`
	Fields []string `json:"fields"`
}

type constraintInfo struct {
	Name           string   `json:"name"`
	Table          string   `json:"table"`
	ForeignKeys    []string `json:"foreignKeys"`
	ReferenceTable string   `json:"referenceTable"`
	References     []string `json:"references"`
	OnDelete       string   `json:"onDelete"`
	OnUpdate       string   `json:"onUpdate"`
}

type joinTableInfo struct {
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
}

type modelInfo struct {
	Table       string           `json:"table"`
	Columns     []columnInfo     `json:"columns"`
	PrimaryKeys []string         `json:"primaryKeys"`
	Indexes     []indexInfo      `json:"indexes"`
	Constraints []constraintInfo `json:"constraints"`
	JoinTables  []joinTableInfo  `json:"joinTables"`
}

func dbNames(fields []*schema.Field) []string {
	names := []string{}
	for _, field := range fields {
		names = append(names, field.DBName)
	}
	return names
}

func describe(s *schema.Schema) modelInfo {
	info := modelInfo{Table: s.Table, PrimaryKeys: dbNames(s.PrimaryFields)}
	for _, field := range s.Fields {
		if field.DBName == "" {
			continue
		}
		info.Columns = append(info.Columns, columnInfo{
			Name:       field.Name,
			DBName:     field.DBName,
			PrimaryKey: field.PrimaryKey,
			Unique:     field.Unique,
			Size:       field.Size,
		})
	}
	indexes := s.ParseIndexes()
	sort.Slice(indexes, func(i, j int) bool { return indexes[i].Name < indexes[j].Name })
	for _, index := range indexes {
		item := indexInfo{Name: index.Name, Unique: index.Class == "UNIQUE"}
		for _, option := range index.Fields {
			item.Fields = append(item.Fields, option.DBName)
		}
		info.Indexes = append(info.Indexes, item)
	}
	relationNames := []string{}
	for name := range s.Relationships.Relations {
		relationNames = append(relationNames, name)
	}
	sort.Strings(relationNames)
	for _, name := range relationNames {
		relation := s.Relationships.Relations[name]
		if relation.JoinTable != nil {
			info.JoinTables = append(info.JoinTables, joinTableInfo{
				Table:   relation.JoinTable.Table,
				Columns: dbNames(relation.JoinTable.Fields),
			})
		}
		if constraint := relation.ParseConstraint(); constraint != nil {
			info.Constraints = append(info.Constraints, constraintInfo{
				Name:           constraint.Name,
				Table:          constraint.Schema.Table,
				ForeignKeys:    dbNames(constraint.ForeignKeys),
				ReferenceTable: constraint.ReferenceSchema.Table,
				References:     dbNames(constraint.References),
				OnDelete:       constraint.OnDelete,
				OnUpdate:       constraint.OnUpdate,
			})
		}
	}
	return info
}

func main() {
	cache := &sync.Map{}
	namer := schema.NamingStrategy{}
	targets := map[string]interface{}{
		"Category":  &models.Category{},
		"Post":      &models.Post{},
		"Tag":       &models.Tag{},
		"Profile":   &models.Profile{},
		"User":      &models.User{},
		"Customer":  &shop.Customer{},
		"Order":     &shop.Order{},
		"OrderItem": &shop.OrderItem{},
		"Product":   &shop.Product{},
		"Label":     &shop.Label{},
		"Comment":   &shop.Comment{},
	}
	result := map[string]modelInfo{}
	for name, target := range targets {
		parsed, err := schema.Parse(target, cache, namer)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
			os.Exit(1)
		}
		result[name] = describe(parsed)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
